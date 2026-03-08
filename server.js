const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const SUPABASE_URL = 'https://symuoxlnfyrneogmjkvv.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// ── Supabase helpers ──
async function supabase(path, method = 'GET', body = null) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : ''
    },
    body: body ? JSON.stringify(body) : null
  });
  return res.json();
}

// ── Build memory context for a plant ──
async function buildMemory(plantId) {
  const isGlobal = !plantId;
  let context = '';

  // Last 5 readings
  const readingsPath = plantId
    ? `garden_readings?plant_id=eq.${plantId}&order=logged_at.desc&limit=5`
    : `garden_readings?order=logged_at.desc&limit=10`;
  const readings = await supabase(readingsPath);
  if (readings.length) {
    context += '\nRECENT METER READINGS:\n';
    readings.forEach(r => {
      const date = new Date(r.logged_at).toLocaleDateString('en-IN');
      context += `- ${date}: Moisture ${r.moisture ?? '—'}, pH ${r.ph ?? '—'}, Light ${r.light ?? '—'}${r.notes ? ', Notes: ' + r.notes : ''}\n`;
    });
  }

  // Last 10 care logs
  const carePath = plantId
    ? `garden_care_logs?plant_id=eq.${plantId}&order=logged_at.desc&limit=10`
    : `garden_care_logs?order=logged_at.desc&limit=15`;
  const care = await supabase(carePath);
  if (care.length) {
    context += '\nRECENT CARE EVENTS:\n';
    care.forEach(c => {
      const date = new Date(c.logged_at).toLocaleDateString('en-IN');
      context += `- ${date}: ${c.care_type}${c.quantity ? ' (' + c.quantity + ')' : ''}${c.notes ? ' — ' + c.notes : ''}\n`;
    });
  }

  // Transfer history
  const transferPath = plantId
    ? `garden_transfers?plant_id=eq.${plantId}&order=transferred_at.desc&limit=5`
    : `garden_transfers?order=transferred_at.desc&limit=10`;
  const transfers = await supabase(transferPath);
  if (transfers.length) {
    context += '\nTRANSFER HISTORY:\n';
    transfers.forEach(t => {
      const date = new Date(t.transferred_at).toLocaleDateString('en-IN');
      context += `- ${date}: Moved from ${t.from_container} → ${t.to_container}${t.notes ? ' (' + t.notes + ')' : ''}\n`;
    });
  }

  // Plant counts by container type
  const plants = await supabase('garden_plants?select=container_type');
  const soil = plants.filter(p => p.container_type === 'soil').length;
  const bottle = plants.filter(p => p.container_type === 'bottle').length;
  const tube = plants.filter(p => p.container_type === 'test_tube').length;
  context += `\nCURRENT COLLECTION: ${soil} soil plant(s), ${bottle} bottle plant(s), ${tube} test tube plant(s).\n`;

  return context;
}

// ── Chat endpoint ──
app.post('/chat', async (req, res) => {
  try {
    const { messages, system, plantId } = req.body;

    // Fetch memory context
    const memory = await buildMemory(plantId || null);

    // Save user message
    const lastUserMsg = messages[messages.length - 1];
    const userText = Array.isArray(lastUserMsg.content)
      ? lastUserMsg.content.find(c => c.type === 'text')?.text || ''
      : lastUserMsg.content;

    await supabase('garden_chat_history', 'POST', {
      plant_id: plantId || null,
      role: 'user',
      content: userText
    });

    // Inject memory into system prompt
    const enrichedSystem = system + '\n\nLOG DATA FROM DATABASE:\n' + memory;

    // Call Claude
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: enrichedSystem,
        messages
      })
    });

    const data = await response.json();
    const reply = data.content?.[0]?.text || '';

    // Save assistant reply
    if (reply) {
      await supabase('garden_chat_history', 'POST', {
        plant_id: plantId || null,
        role: 'assistant',
        content: reply
      });
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Log care event ──
app.post('/log/care', async (req, res) => {
  try {
    const { plant_id, care_type, quantity, notes } = req.body;
    const result = await supabase('garden_care_logs', 'POST', { plant_id, care_type, quantity, notes });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Log meter reading ──
app.post('/log/reading', async (req, res) => {
  try {
    const { plant_id, moisture, ph, light, notes } = req.body;
    const result = await supabase('garden_readings', 'POST', { plant_id, moisture, ph, light, notes });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Log transfer ──
app.post('/log/transfer', async (req, res) => {
  try {
    const { plant_id, from_container, to_container, notes } = req.body;
    // Save transfer log
    await supabase('garden_transfers', 'POST', { plant_id, from_container, to_container, notes });
    // Update plant container type
    await fetch(`${SUPABASE_URL}/rest/v1/garden_plants?id=eq.${plant_id}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ container_type: to_container, updated_at: new Date().toISOString() })
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Get plant counts ──
app.get('/counts', async (req, res) => {
  try {
    const plants = await supabase('garden_plants?select=container_type');
    const soil = plants.filter(p => p.container_type === 'soil').length;
    const bottle = plants.filter(p => p.container_type === 'bottle').length;
    const tube = plants.filter(p => p.container_type === 'test_tube').length;
    res.json({ soil, bottle, tube, total: soil + bottle + tube });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => res.send('Garden proxy running'));

app.listen(process.env.PORT || 8000);

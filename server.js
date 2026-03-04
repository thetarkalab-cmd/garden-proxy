const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.post('/chat', async (req, res) => {
  try {
    const key = process.env.GEMINI_API_KEY;
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + key,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body)
      }
    );
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  const key = process.env.GEMINI_API_KEY;
  res.send('Garden proxy running. Key present: ' + !!key + '. Key length: ' + (key ? key.length : 0));
});

app.listen(process.env.PORT || 8000);

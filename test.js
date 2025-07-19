const express = require('express');
const app = express();
const port = 5000;

// Allow all connections (temporarily)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  next();
});

app.get('/test', (req, res) => {
  res.send("Hello World!");
});

app.listen(port, () => {
  console.log(`Test server running on port ${port}`);
});p

const express = require('express');
const scraperRoutesFactory = require('./routes/scraper.routes');
const cors = require('cors');


const app = express();

// Middleware
app.use(express.json());
app.use(cors());
app.use(express.urlencoded({ extended: true }));

// Mount routes later, will pass io in server.js
// app.use('/api/scraper', scraperRoutesFactory(io));

app.get('/', (req, res) => res.send('Scraper API running'));

module.exports = app;

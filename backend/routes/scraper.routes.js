const express = require('express');
const router = express.Router();
const scraperServiceFactory = require('../services/scraper.service');

module.exports = (io) => {
  const scraperService = scraperServiceFactory(io);

  router.post('/navigate', async (req, res) => {
    const { userId, url } = req.body;
    try {
      await scraperService.navigate(userId, url);
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.post('/selection-mode', async (req, res) => {
    const { userId } = req.body;
    try {
      await scraperService.injectSelection(userId);
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};

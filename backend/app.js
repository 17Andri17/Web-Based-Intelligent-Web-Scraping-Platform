const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth.routes');
const workflowsRoutes = require('./routes/workflows.routes');
const customActionsRoutes = require('./routes/customActions.routes');

const app = express();

// Middleware
app.use(express.json({ limit: '4mb' }));
app.use(cors());
app.use(express.urlencoded({ extended: true }));

app.use('/api/auth', authRoutes);
app.use('/api/workflows', workflowsRoutes);
app.use('/api/custom-actions', customActionsRoutes);

app.get('/', (req, res) => res.send('Scraper API running'));

module.exports = app;

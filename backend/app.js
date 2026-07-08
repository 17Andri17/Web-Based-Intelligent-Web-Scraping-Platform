const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth.routes');
const workflowsRoutes = require('./routes/workflows.routes');
const customActionsRoutes = require('./routes/customActions.routes');
const aiRoutes = require('./routes/ai.routes');
const schedulesRoutes = require('./routes/schedules.routes');
const runsRoutes = require('./routes/runs.routes');
const proxiesRoutes = require('./routes/proxies.routes');

const app = express();

// Middleware
app.use(express.json({ limit: '4mb' }));
app.use(cors());
app.use(express.urlencoded({ extended: true }));

app.use('/api/auth', authRoutes);
app.use('/api/workflows', workflowsRoutes);
app.use('/api/custom-actions', customActionsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/schedules', schedulesRoutes);
app.use('/api/runs', runsRoutes);
app.use('/api/proxies', proxiesRoutes);

app.get('/', (req, res) => res.send('Scraper API running'));

module.exports = app;

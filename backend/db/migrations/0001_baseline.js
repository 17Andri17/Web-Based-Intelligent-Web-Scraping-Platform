'use strict';

// Baseline migration: the full application schema as it stood when the
// migration runner was introduced. Because every statement is idempotent
// (CREATE … IF NOT EXISTS), applying this against a database that legacy
// db/index.js already provisioned is a harmless no-op — it simply records
// the baseline as "applied" so future migrations build on a known state.

const schema = require('../schema');

module.exports = {
  id: '0001_baseline',
  up(dialect) {
    return schema.statements(dialect);
  },
};

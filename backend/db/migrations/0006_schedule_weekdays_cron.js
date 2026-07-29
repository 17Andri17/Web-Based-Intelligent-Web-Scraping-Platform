'use strict';

// Richer scheduling — see docs/PLATFORM_ANALYSIS.md §5.2.3.
//
//   • weekdays        — CSV of allowed weekday numbers (0=Sun … 6=Sat), e.g.
//                       "1,2,3,4,5" for weekdays only. NULL/empty = every day.
//                       Acts as a filter on interval-generated slots (in the
//                       server's local timezone, which for a local single-user
//                       install is the user's).
//   • cron_expression — an optional 5-field cron string. When set it drives the
//                       next-run time entirely (interval/anchor/weekdays ignored),
//                       the power-user escape hatch.

module.exports = {
  id: '0006_schedule_weekdays_cron',
  up() {
    return [
      `ALTER TABLE schedules ADD COLUMN weekdays TEXT`,
      `ALTER TABLE schedules ADD COLUMN cron_expression TEXT`,
    ];
  },
};

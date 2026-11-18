/**
 * Migration 003 — formerly "add team scheduling tables".
 *
 * Team scheduling belonged to the hosted edition and has been removed. The
 * migration keeps its number so databases that already ran it are not
 * affected, but it no longer creates anything. Databases created before
 * the removal keep their team tables, unused.
 */

export default {
  id: 3,
  name: 'add_team_scheduling',

  up() {
    // Nothing to do
  },
};

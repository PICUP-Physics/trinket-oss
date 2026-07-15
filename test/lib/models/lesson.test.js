const _       = require('underscore');
const ownable = require('../../../lib/models/plugins/ownable');

describe('Lesson model', () => {
  describe('plugins', () => {
    it('implements the ownable plugin', () => {
      const plugin = _.find(Lesson.plugins, (p) => p === ownable);
      expect(plugin).toBeDefined();
    });
  });
});

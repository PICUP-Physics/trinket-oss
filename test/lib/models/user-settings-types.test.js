'use strict';
// #367: the settings pages post form fields, so updateSettings receives
// strings ("4", "false"). Mongo casts them through the schema; Firestore
// stored them as given, and a pythonTab of "4" made the plain editor type
// "41", while a disableAceEditor of "false" is truthy. Both backends must
// hand back the schema's types.
const defaults = require('../../helpers/defaults');

describe('User settings keep their schema types', () => {
  let user;

  beforeEach(async () => {
    user = new User(defaults.user);
    await user.save();
  });

  afterEach(async () => {
    await user.deleteOne();
  });

  it('updateSettings stores form strings as numbers and booleans', async () => {
    await user.updateSettings({ pythonTab: '4', htmlTab: '3', disableAceEditor: 'false', lineWrapping: 'true' });
    const s = (await User.findById(user.id)).settings;
    expect(s.pythonTab).toBe(4);
    expect(s.htmlTab).toBe(3);
    expect(s.disableAceEditor).toBe(false);
    expect(s.lineWrapping).toBe(true);
  });

  it('a user saved with string settings before the fix loads with the right types', async () => {
    // Write the strings straight through, the way updateSettings used to.
    await User.findByIdAndUpdate(user.id, { $set: { settings: Object.assign({}, user.settings.toJSON ? user.settings.toJSON() : user.settings, {
      pythonTab: '4', disableAceEditor: 'false', lineWrapping: 'true',
    }) } });
    const s = (await User.findById(user.id)).settings;
    expect(s.pythonTab).toBe(4);
    expect(s.disableAceEditor).toBe(false);
    expect(s.lineWrapping).toBe(true);
  });

  it('a value that is not a number or boolean falls back to the default', async () => {
    await user.updateSettings({ pythonTab: 'abc', disableAceEditor: 'maybe' });
    const s = (await User.findById(user.id)).settings;
    expect(s.pythonTab).toBe(2);
    expect(s.disableAceEditor).toBe(false);
  });

  it('leaves the other settings alone', async () => {
    await user.updateSettings({ theme: 'monokai', pythonTab: 4 });
    const s = (await User.findById(user.id)).settings;
    expect(s.theme).toBe('monokai');
    expect(s.pythonTab).toBe(4);
  });
});

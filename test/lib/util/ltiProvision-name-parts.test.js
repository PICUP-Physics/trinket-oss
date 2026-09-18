'use strict';

// Keeping the given/family name parts the LMS sends.
//
// Both LTI versions hand over the name in parts — 1.3 as the standard
// `given_name`/`family_name` claims, 1.1 as `lis_person_name_given`/`_family`
// — and we used to keep only the joined string. That left every surname-ordered
// view deriving a surname it could have simply known, and derivation cannot be
// right for names where the family name comes first.
const ltiProvision = require('../../../lib/util/ltiProvision');
const User         = require('../../../lib/models/user');

const platform = { issuer: 'https://lms.example', trustEmail: true };
const uniq = () => Math.random().toString(36).slice(2, 10);

function claimsFor(extra) {
  const id = uniq();
  return Object.assign({
    iss: 'https://lms.example',
    sub: 'sub-' + id,
    email: 'parts-' + id + '@example.com',
    name: 'Ana de la Cruz'
  }, extra || {});
}

describe('ltiProvision keeps the name parts', () => {
  it('stores given and family name when the platform sends them', async () => {
    const c = claimsFor({ given_name: 'Ana', family_name: 'de la Cruz' });
    const user = await ltiProvision.provisionUser(c, platform, {});

    const saved = await User.findById(user.id);
    expect(saved.givenName).toBe('Ana');
    expect(saved.familyName).toBe('de la Cruz');
    expect(saved.fullname, 'the display name is unchanged').toBe('Ana de la Cruz');
  });

  it('keeps the parts for a name derivation would get backwards', async () => {
    const c = claimsFor({ name: 'Zhang Wei', given_name: 'Wei', family_name: 'Zhang' });
    const user = await ltiProvision.provisionUser(c, platform, {});

    const saved = await User.findById(user.id);
    expect(saved.familyName, 'family name first is exactly what guessing misses').toBe('Zhang');
  });

  it('leaves the parts unset when the platform sends none', async () => {
    const c = claimsFor();
    const user = await ltiProvision.provisionUser(c, platform, {});

    const saved = await User.findById(user.id);
    expect(saved.givenName).toBeFalsy();
    expect(saved.familyName).toBeFalsy();
    expect(saved.fullname).toBe('Ana de la Cruz');
  });

  it('refreshes the parts on a later launch — names change', async () => {
    const c = claimsFor({ given_name: 'Ana', family_name: 'Cruz' });
    const first = await ltiProvision.provisionUser(c, platform, {});

    const married = Object.assign({}, c, { name: 'Ana Okonkwo', family_name: 'Okonkwo' });
    const second = await ltiProvision.provisionUser(married, platform, {});
    expect(String(second.id), 'the same person, not a new account').toBe(String(first.id));

    const saved = await User.findById(first.id);
    expect(saved.familyName).toBe('Okonkwo');
  });

  it('does not clear stored parts when a later launch omits them', async () => {
    const c = claimsFor({ given_name: 'Ana', family_name: 'Cruz' });
    const first = await ltiProvision.provisionUser(c, platform, {});

    const bare = Object.assign({}, c);
    delete bare.given_name; delete bare.family_name;
    await ltiProvision.provisionUser(bare, platform, {});

    const saved = await User.findById(first.id);
    expect(saved.familyName, 'a silent platform must not erase what we knew').toBe('Cruz');
  });
});

// Paths, fragment tokens (F.4, F.14), return addresses and the per-tab sign-in state (H.6, H.7).
import { describe, expect, it, vi } from 'vitest';
import {
  AUTH_PATHS, authPageOf, beginGuestAccess, keptSearch, peekReturnTo, readReauth, readStep, safeReturnTo, ssoStartUrl, storeReauth,
  storeReturnTo, storeStep, takeCsrfFragment, takeFragmentToken, takeReturnTo,
} from '../../src/auth/routes';
import type { StorageLike } from '../../src/auth/routes';
import { fakeHistory, fakeLocation, memoryStore } from './helpers';

const TOKEN = 'R3Vlc3QtQWNjZXNzLVRva2VuLVZhbHVlLTAxMjM0NTY3ODk';

describe('pages', () => {
  it('maps every page path, with or without a trailing slash, and nothing else', () => {
    expect(AUTH_PATHS).toEqual({
      login: '/login', mfa: '/login/mfa', enrol: '/login/enrol', forgot: '/forgot-password', reset: '/reset-password', invite: '/invite', guest: '/guest',
    });
    for (const [page, path] of Object.entries(AUTH_PATHS)) {
      expect(authPageOf(path)).toBe(page);
      expect(authPageOf(`${path}/`)).toBe(page);
    }
    expect(authPageOf('/')).toBeNull();
    expect(authPageOf('/login/other')).toBeNull();
    expect(authPageOf('/guests')).toBeNull();
  });
});

describe('takeFragmentToken', () => {
  it('reads #token=<value>, then replaces the address without the fragment', () => {
    const history = fakeHistory();
    const token = takeFragmentToken(fakeLocation(`/reset-password?lang=id#token=${TOKEN}`), history);
    expect(token).toBe(TOKEN);
    expect(history.urls).toEqual(['/reset-password?lang=id']);
  });

  it('reads the raw fragment of a guest link #<token>', () => {
    const history = fakeHistory();
    expect(takeFragmentToken(fakeLocation(`/guest#${TOKEN}`), history)).toBe(TOKEN);
    expect(history.urls).toEqual(['/guest']);
  });

  it('removes a fragment that holds no valid token and returns null', () => {
    for (const hash of ['#token=short', '#a b c', '#token=', `#token=${TOKEN}%3Cscript%3E`, '#other=1']) {
      const history = fakeHistory();
      expect(takeFragmentToken(fakeLocation(`/invite${hash}`), history)).toBeNull();
      expect(history.urls).toEqual(['/invite']);
    }
  });

  it('leaves the address alone when there is no fragment', () => {
    const history = fakeHistory();
    expect(takeFragmentToken(fakeLocation('/guest'), history)).toBeNull();
    expect(history.urls).toEqual([]);
  });
});

describe('beginGuestAccess (F.14 step 2)', () => {
  it('reads the token, replaces the address without the fragment, then posts the token', async () => {
    const events: string[] = [];
    const history = fakeHistory(events);
    const post = vi.fn(async (token: string) => {
      events.push(`post ${token}`);
      return { status: 'code_sent' };
    });
    const result = await beginGuestAccess(post, fakeLocation(`/guest?theme=dark#${TOKEN}`), history);
    expect(result).toEqual({ status: 'code_sent' });
    expect(events).toEqual(['replace /guest?theme=dark', `post ${TOKEN}`]);
  });

  it('posts nothing without a token', async () => {
    const post = vi.fn();
    expect(await beginGuestAccess(post, fakeLocation('/guest'), fakeHistory())).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });
});

describe('CSRF hand-over of an identity provider callback', () => {
  it('reads #csrf= on the second-factor page and removes it', () => {
    const history = fakeHistory();
    expect(takeCsrfFragment(fakeLocation('/login/mfa#csrf=b1T7c0Qy9Zq2R8w4XkP6mN3vL5sJ0hG1fD2eC3aB4c5'), history)).toBe('b1T7c0Qy9Zq2R8w4XkP6mN3vL5sJ0hG1fD2eC3aB4c5');
    expect(history.urls).toEqual(['/login/mfa']);
    expect(takeCsrfFragment(fakeLocation('/login/mfa'), fakeHistory())).toBeNull();
    expect(takeCsrfFragment(fakeLocation('/login/mfa#csrf=x'), fakeHistory())).toBeNull();
  });
});

describe('return address', () => {
  it('accepts relative application paths only', () => {
    expect(safeReturnTo('/')).toBe('/');
    expect(safeReturnTo('/?theme=dark&lang=id')).toBe('/?theme=dark&lang=id');
    for (const bad of ['https://evil.example/', '//evil.example/', '/\\evil', 'relative', '/login', '/login/mfa?x=1', '/a b', '', null, undefined, `/${'a'.repeat(2048)}`]) {
      expect(safeReturnTo(bad as string)).toBeNull();
    }
  });

  it('is stored for the next sign-in, read once, and defaults to /', () => {
    const store = memoryStore();
    expect(takeReturnTo(store)).toBe('/');
    storeReturnTo(store, '/?theme=dark');
    expect(peekReturnTo(store)).toBe('/?theme=dark');
    expect(takeReturnTo(store)).toBe('/?theme=dark');
    expect(takeReturnTo(store)).toBe('/');
    storeReturnTo(store, 'https://evil.example/');
    expect(takeReturnTo(store)).toBe('/');
  });
});

describe('per-tab sign-in state', () => {
  it('keeps the pending step and its CSRF token', () => {
    const store = memoryStore();
    expect(readStep(store)).toBeNull();
    storeStep(store, { stage: 'mfa', csrfToken: 'pending-token-0123456789' });
    expect(readStep(store)).toEqual({ stage: 'mfa', csrfToken: 'pending-token-0123456789' });
    storeStep(store, { stage: 'enrol', csrfToken: 't0123456789abcdef', guest: true });
    expect(readStep(store)).toEqual({ stage: 'enrol', csrfToken: 't0123456789abcdef', guest: true });
    storeStep(store, null);
    expect(readStep(store)).toBeNull();
    store.setItem('mscd.auth.step', '{broken');
    expect(readStep(store)).toBeNull();
    store.setItem('mscd.auth.step', JSON.stringify({ stage: 'other', csrfToken: 'x' }));
    expect(readStep(store)).toBeNull();
  });

  it('keeps an organisation switch that needs a new sign-in', () => {
    const store = memoryStore();
    const reauth = { methods: { local: true, providers: [{ slug: 'keycloak', kind: 'oidc' as const, label: 'Keycloak' }] }, org: 'bsd' };
    storeReauth(store, reauth);
    expect(readReauth(store)).toEqual(reauth);
    storeReauth(store, null);
    expect(readReauth(store)).toBeNull();
    store.setItem('mscd.auth.reauth', JSON.stringify({ methods: { local: 'yes' } }));
    expect(readReauth(store)).toBeNull();
  });

  it('works without storage and when storage throws', () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    for (const store of [null, throwing]) {
      storeReturnTo(store, '/x');
      expect(takeReturnTo(store)).toBe('/');
      storeStep(store, { stage: 'mfa', csrfToken: 'x0123456789abcdef' });
      expect(readStep(store)).toBeNull();
      expect(readReauth(store)).toBeNull();
    }
  });
});

describe('identity provider start', () => {
  it('builds the OIDC or SAML start route with a relative return path and an invitation token', () => {
    expect(ssoStartUrl({ slug: 'entra-id', kind: 'oidc' })).toBe('/api/v1/auth/oidc/entra-id/start');
    expect(ssoStartUrl({ slug: 'adfs', kind: 'saml' }, { returnTo: '/?theme=dark' })).toBe('/api/v1/auth/saml/adfs/start?returnTo=%2F%3Ftheme%3Ddark');
    expect(ssoStartUrl({ slug: 'kc', kind: 'oidc' }, { returnTo: 'https://evil.example/', invitation: TOKEN })).toBe(`/api/v1/auth/oidc/kc/start?invitation=${TOKEN}`);
    expect(ssoStartUrl({ slug: 'kc', kind: 'oidc' }, { invitation: 'bad token' })).toBe('/api/v1/auth/oidc/kc/start');
  });
});

describe('kept display settings', () => {
  it('keeps drill, density, layout, font, lang, theme, deploy and org; drops the rest', () => {
    expect(keptSearch('?theme=dark&lang=id&error=no_account&token=x&drill=page&org=ndt')).toBe('?drill=page&lang=id&theme=dark&org=ndt');
    expect(keptSearch('?density=dense&layout=rows&font=source&deploy=onprem')).toBe('?density=dense&layout=rows&font=source&deploy=onprem');
    expect(keptSearch('')).toBe('');
  });
});

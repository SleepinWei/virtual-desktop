export const externalSites = {
  example: { label: 'Example Domain · probe only', interactive: false, url: 'https://example.com/',
    navigationDomains: ['example.com'], resourceDomains: ['example.com'] },
  iana: { label: 'IANA documentation · probe only', interactive: false, url: 'https://www.iana.org/help/example-domains',
    navigationDomains: ['iana.org'], resourceDomains: ['iana.org'] },
  cern: { label: 'CERN first website · probe only', interactive: false, url: 'https://info.cern.ch/hypertext/WWW/TheProject.html',
    navigationDomains: ['info.cern.ch'], resourceDomains: ['info.cern.ch'] },
  hackernews: { label: 'Hacker News · probe only', interactive: false, url: 'https://news.ycombinator.com/',
    navigationDomains: ['news.ycombinator.com'], resourceDomains: ['ycombinator.com'] },
  python: { label: 'Python.org documentation · probe only', interactive: false, url: 'https://www.python.org/doc/',
    navigationDomains: ['python.org'], resourceDomains: ['python.org', 'ajax.googleapis.com'] },
  xiaohongshu: { label: 'Xiaohongshu · probe only', interactive: false, url: 'https://www.xiaohongshu.com/explore',
    navigationDomains: ['xiaohongshu.com'], resourceDomains: ['xiaohongshu.com', 'xhscdn.com'] },
  bilibili: { label: 'Bilibili · static image preview', interactive: true, imageAnimationPolicy: 'first-frame', url: 'https://www.bilibili.com/',
    navigationDomains: ['bilibili.com'], resourceDomains: ['bilibili.com', 'hdslb.com', 'bilivideo.com'] },
};
const matches = (host, domains) => domains.some(domain => host === domain || host.endsWith('.' + domain));
export function resolveSiteUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  const input = value.trim();
  if (!input || /[\u0000-\u001f\u007f\\]/.test(input)) return null;
  try {
    const address = new URL(input.startsWith('//') ? 'https:' + input
      : /^[a-z][a-z\d+.-]*:/i.test(input) ? input : 'https://' + input);
    for (const site of Object.keys(externalSites)) {
      if (allowedSiteRequest(site, address.href, { navigation: true })) return { site, url: address.href };
    }
  } catch {}
  return null;
}

export function siteAccessIssue(site, address) {
  try {
    const url = new URL(address);
    if (site === 'xiaohongshu' && url.protocol === 'https:' && matches(url.hostname, ['xiaohongshu.com']) &&
        url.pathname === '/website-login/error' && url.searchParams.get('error_code') === '300012') {
      return '小红书拒绝了当前浏览会话（300012）。日常浏览器的登录与访问状态不会自动共享到此会话；可先使用哔哩哔哩。';
    }
  } catch {}
  return null;
}
export function allowedSiteRequest(site, address, { navigation = false, method = 'GET' } = {}) {
  const policy = externalSites[site];
  if (!policy) return false;
  try {
    const url = new URL(address);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') &&
      matches(url.hostname, navigation ? policy.navigationDomains : policy.resourceDomains) &&
      ['GET', 'HEAD', 'POST', 'OPTIONS'].includes(method);
  } catch { return false; }
}

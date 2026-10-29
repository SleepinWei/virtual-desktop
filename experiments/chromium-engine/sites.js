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
  bilibili: { label: 'Bilibili · probe only', interactive: false, url: 'https://www.bilibili.com/',
    navigationDomains: ['bilibili.com'], resourceDomains: ['bilibili.com', 'hdslb.com', 'bilivideo.com'] },
};
const matches = (host, domains) => domains.some(domain => host === domain || host.endsWith('.' + domain));
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

export const externalSites = {
  example: { label: 'Example Domain · external preview', url: 'https://example.com/',
    navigationDomains: ['example.com'], resourceDomains: ['example.com'] },
  xiaohongshu: { label: 'Xiaohongshu · probe only', interactive: false, url: 'https://www.xiaohongshu.com/explore',
    navigationDomains: ['xiaohongshu.com'], resourceDomains: ['xiaohongshu.com', 'xhscdn.com'] },
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

/** Atom / RSS 订阅解析（构建期与浏览器水合共用，无 Node 依赖） */

export interface FriendPost {
  title: string;
  link: string;
}

/** 取标签内的纯文本 */
function pick(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!m) return '';

  return decodeEntities(
    m[1]
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, '')
      .trim()
  );
}

/** 解 HTML 实体；数字实体也要处理，标题里常见 &#038; &#124; */
function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    lsquo: '‘',
    rsquo: '’',
    ldquo: '“',
    rdquo: '”',
  };

  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1].toLowerCase() === 'x'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }

    return named[body.toLowerCase()] ?? whole;
  });
}

/** Atom 的 link 带 rel，优先 alternate */
function atomLink(block: string): string {
  let fallback = '';

  for (const [, attrs] of block.matchAll(/<link\b([^>]*)\/?>/gi)) {
    const href = attrs.match(/href=["']([^"']+)["']/i)?.[1];
    if (!href) continue;

    const rel = attrs.match(/rel=["']([^"']+)["']/i)?.[1] ?? 'alternate';
    if (rel === 'alternate') return decodeEntities(href);
    if (!fallback) fallback = decodeEntities(href);
  }

  return fallback;
}

/** 从 Atom 或 RSS 文本里抽最近条目 */
export function parseFeed(xml: string, limit = 3): FriendPost[] {
  const posts: FriendPost[] = [];

  for (const m of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)) {
    const title = pick(m[1], 'title');
    const link = atomLink(m[1]);
    if (title && link) posts.push({ title, link });
    if (posts.length >= limit) return posts;
  }

  if (posts.length) return posts;

  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const title = pick(m[1], 'title');
    const link =
      pick(m[1], 'link') ||
      decodeEntities(m[1].match(/<link\b[^>]*href=["']([^"']+)["']/i)?.[1] || '');
    if (title && link) posts.push({ title, link });
    if (posts.length >= limit) return posts;
  }

  return posts;
}

/** 补全相对链接并限制只放行 http(s) 协议 */
export function resolvePostLink(rawLink: string, baseLink: string): string | null {
  try {
    const resolved = new URL(rawLink, baseLink);
    return resolved.protocol === 'https:' || resolved.protocol === 'http:' ? resolved.href : null;
  } catch {
    return null;
  }
}

/** 解析订阅并过滤出可安全跳转的条目 */
export function extractFeedPosts(xml: string, baseLink: string, limit = 3): FriendPost[] {
  if (!/<(feed|rss)\b/i.test(xml)) return [];

  const out: FriendPost[] = [];
  for (const post of parseFeed(xml, limit)) {
    const link = resolvePostLink(post.link, baseLink);
    if (link) out.push({ title: post.title, link });
  }
  return out;
}

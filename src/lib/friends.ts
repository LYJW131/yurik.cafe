/** 友链数据与站点订阅解析 */
import fs from 'node:fs';
import path from 'node:path';
import { extractFeedPosts, parseFeed, type FriendPost } from './feed-parser';
import { site } from './site';

export { parseFeed, type FriendPost };

export interface Friend {
  title: string;
  description: string;
  link: string;
  avatar: string;
  /** 订阅地址；留空则按常见路径探测 */
  feed?: string;
}

export interface FriendWithPosts extends Friend {
  posts: FriendPost[];
  /** 允许本站跨源读取的订阅地址，供前端水合刷新 */
  liveFeed?: string;
}

export interface ResolvedFeed {
  url: string;
  xml: string;
  cors: boolean;
}

const DATA_DIR = path.resolve(process.cwd(), 'src/content/_data');

/** 站点没写 feed 时按这个顺序试 */
const FEED_GUESSES = ['/atom.xml', '/rss.xml', '/feed.xml', '/feed', '/index.xml', '/rss'];

const FETCH_TIMEOUT = 8000;

const SITE_ORIGIN = (() => {
  try {
    return new URL(site.url).origin;
  } catch {
    return site.url.replace(/\/+$/, '');
  }
})();

let cache: Friend[] | null = null;

/** 读取友链；文件不存在返回空数组 */
export async function getFriends(): Promise<Friend[]> {
  if (cache) return cache;

  const file = path.join(DATA_DIR, 'friends.json');
  if (!fs.existsSync(file)) {
    cache = [];
    return cache;
  }

  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);

    if (!Array.isArray(parsed)) {
      cache = [];
      return cache;
    }

    cache = parsed
      .filter((item) => item && typeof item === 'object')
      .map((item) => ({
        title: String(item.title ?? '').trim(),
        description: String(item.description ?? item.desc ?? '').trim(),
        link: String(item.link ?? '').trim(),
        avatar: String(item.avatar ?? '').trim(),
        feed: String(item.feed ?? '').trim() || undefined,
      }))
      .filter((item) => item.title && item.link);

    return cache;
  } catch (error) {
    console.warn(`[friends] failed to read ${file}: ${String(error)}`);
    cache = [];
    return cache;
  }
}

/** 检查响应头是否允许本站浏览器跨源拉取 */
export function allowsBrowserCors(allowOrigin: string | null, siteOrigin = SITE_ORIGIN): boolean {
  if (!allowOrigin) return false;
  const trimmed = allowOrigin.trim();
  return trimmed === '*' || trimmed === siteOrigin;
}

/** 带超时的抓取，失败返回 null */
async function tryFetch(url: string): Promise<ResolvedFeed | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; BylineBot/1.0)',
        accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml, */*',
        origin: SITE_ORIGIN,
      },
      redirect: 'follow',
    });

    if (!res.ok) return null;

    // 有的站点对任何路径都回 HTML，这类排除
    const type = res.headers.get('content-type') ?? '';
    if (/text\/html/i.test(type)) return null;

    const xml = await res.text();
    const cors = allowsBrowserCors(res.headers.get('access-control-allow-origin'));
    return { url: res.url || url, xml, cors };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 找订阅地址：先看配置，再按常见路径探测 */
export async function resolveFeed(friend: Friend): Promise<ResolvedFeed | null> {
  const looksLikeFeed = (fetched: ResolvedFeed | null): fetched is ResolvedFeed =>
    !!fetched && /<(feed|rss)\b/i.test(fetched.xml);

  if (friend.feed) {
    const fetched = await tryFetch(friend.feed);
    return looksLikeFeed(fetched) ? fetched : null;
  }

  const base = friend.link.replace(/\/+$/, '');
  for (const guess of FEED_GUESSES) {
    const fetched = await tryFetch(base + guess);
    if (looksLikeFeed(fetched)) return fetched;
  }

  return null;
}

/** 取友链各自的最近文章；没有订阅的站点留空 */
export async function getFriendsWithPosts(limit = 3): Promise<FriendWithPosts[]> {
  const friends = await getFriends();

  return Promise.all(
    friends.map(async (friend) => {
      const resolved = await resolveFeed(friend);
      if (!resolved) return { ...friend, posts: [] };

      const posts = extractFeedPosts(resolved.xml, friend.link, limit);
      return {
        ...friend,
        posts,
        ...(resolved.cors ? { liveFeed: resolved.url } : {}),
      };
    })
  );
}

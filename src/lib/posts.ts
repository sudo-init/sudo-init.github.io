import { getCollection, type CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'blog'>;

/** 발행된 글을 최신순으로. 초안은 개발 서버에서만 보인다. */
export async function getPublishedPosts(): Promise<Post[]> {
  const posts = await getCollection(
    'blog',
    ({ data }) => import.meta.env.DEV || !data.draft,
  );
  return posts.sort(
    (a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf(),
  );
}

/**
 * 한글은 글자 수, 영문은 단어 수로 나눠 세고 합산한다.
 * 한국어 본문에 영문 용어가 섞이는 글에서 단어 수만 세면 크게 빗나가기 때문.
 */
export function readingTime(body = ''): number {
  const text = body
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  const korean = text.match(/[가-힣]/g)?.length ?? 0;
  const words = text.match(/[A-Za-z0-9]+/g)?.length ?? 0;
  return Math.max(1, Math.round(korean / 500 + words / 220));
}

export function tagSlug(tag: string): string {
  return tag.trim().toLowerCase().replace(/\s+/g, '-');
}

export function tagHref(tag: string): string {
  return `/tags/${encodeURIComponent(tagSlug(tag))}/`;
}

export function postHref(post: Post): string {
  return `/posts/${post.id}/`;
}

export type TagGroup = { slug: string; tag: string; posts: Post[] };

/** 태그별로 글을 묶어 글 수가 많은 순, 같으면 이름순으로 정렬. */
export function groupByTag(posts: Post[]): TagGroup[] {
  const groups = new Map<string, TagGroup>();
  for (const post of posts) {
    for (const tag of post.data.tags) {
      const slug = tagSlug(tag);
      const group = groups.get(slug) ?? { slug, tag, posts: [] };
      group.posts.push(post);
      groups.set(slug, group);
    }
  }
  return [...groups.values()].sort(
    (a, b) => b.posts.length - a.posts.length || a.tag.localeCompare(b.tag),
  );
}

/**
 * 프론트매터의 `2026-08-12` 는 UTC 자정으로 파싱되므로 UTC 기준으로 읽는다.
 * 로컬 시간대로 읽으면 빌드 머신에 따라 하루씩 밀린다.
 */
export function formatDate(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const dd = `${date.getUTCDate()}`.padStart(2, '0');
  return `${yyyy}.${mm}.${dd}`;
}

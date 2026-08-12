import { getCollection, type CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'blog'>;

/**
 * 발행된 글을 최신순으로. 초안은 개발 서버에서만 보인다.
 *
 * 같은 날 두 편을 쓰면 날짜만으로는 순서가 정해지지 않는다. 그때는
 * 프론트매터에 시각까지 적으면 되고(`2026-08-12T16:30+09:00`),
 * 그마저 같으면 파일 이름을 역순으로 써서 빌드마다 순서가 흔들리지 않게 한다.
 */
export async function getPublishedPosts(): Promise<Post[]> {
  const posts = await getCollection(
    'blog',
    ({ data }) => import.meta.env.DEV || !data.draft,
  );
  return posts.sort(
    (a, b) =>
      b.data.pubDate.valueOf() - a.data.pubDate.valueOf() ||
      b.id.localeCompare(a.id),
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
 * 항상 한국 시간으로 표시한다. 빌드 머신 시간대(GitHub Actions는 UTC)에 따라
 * 날짜가 하루씩 밀리지 않고, 시각까지 적은 글도 쓴 날짜 그대로 나온다.
 */
const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function formatDate(date: Date): string {
  return dateFormatter.format(date).replaceAll('-', '.');
}

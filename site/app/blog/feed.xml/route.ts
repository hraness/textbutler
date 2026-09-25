import { ATOM_FEED_CONTENT_TYPE } from '@hraness/web-discovery';

import { blogAtomFeed } from '../../_lib/blog';

export const dynamic = 'force-static';

// Lists indexable posts only; quarantined posts never enter the feed.
export function GET() {
  return new Response(blogAtomFeed(), {
    headers: { 'Content-Type': ATOM_FEED_CONTENT_TYPE },
  });
}

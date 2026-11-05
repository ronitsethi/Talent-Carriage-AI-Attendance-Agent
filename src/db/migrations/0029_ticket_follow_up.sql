-- A ticket raised because the problem in an earlier, closed ticket was still not
-- right: the query that earlier ticket belongs to.
ALTER TABLE "queries" ADD COLUMN "follows_query_id" uuid;

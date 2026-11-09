import Link from "next/link";

export default async function Home() {
  await fetch("/api/stats");
  return <Link href={`/listings/${42}`}>Open listing</Link>;
}

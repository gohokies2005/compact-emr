// Circle avatar with an inline-SVG silhouette fallback (P3 identity block). The image renders
// from a short-TTL presigned GET (MeUser.avatarUrl); absent/expired -> silhouette, never broken.
export function AvatarCircle({
  url,
  name,
  size = 40,
}: {
  readonly url?: string | null;
  readonly name?: string | null;
  readonly size?: number;
}) {
  if (url) {
    return (
      <img
        src={url}
        alt={name ? `${name} avatar` : 'Your avatar'}
        width={size}
        height={size}
        className="rounded-full border border-slate-200 object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <svg
      data-testid="avatar-fallback"
      role="img"
      aria-label={name ? `${name} avatar placeholder` : 'Avatar placeholder'}
      width={size}
      height={size}
      viewBox="0 0 40 40"
      className="rounded-full border border-slate-200 bg-slate-100 text-slate-400"
    >
      <circle cx="20" cy="15" r="7" fill="currentColor" />
      <path d="M6.5 36c1.8-7.5 8.3-10.5 13.5-10.5S31.7 28.5 33.5 36Z" fill="currentColor" />
    </svg>
  );
}

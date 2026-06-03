/** @type {import('next').NextConfig} */
const nextConfig = {
  // No /api route handlers remain in this project.
  // All data comes from the Hono backend (backend/).
  //
  // Required environment variables:
  //   NEXT_PUBLIC_API_URL — full URL of the Hono backend.
  //   Example .env.local:  NEXT_PUBLIC_API_URL=http://localhost:4000
  //   Example production:  NEXT_PUBLIC_API_URL=https://api.yourdomain.com
};

export default nextConfig;

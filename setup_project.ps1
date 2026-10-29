# Dryer Vent Squad - Project Setup Script
$ErrorActionPreference = "Stop"

Write-Host "🚀 Creating Dryer Vent Squad Directory Structure..." -ForegroundColor Cyan

$directories = @(
    "app",
    "app/api/save-booking",
    "app/api/jobber/oauth/callback",
    "app/api/jobber/sync-booking",
    "app/api/jobber/webhook",
    "lib",
    "docs"
)

foreach ($dir in $directories) {
    if (-not (Test-Path -Path $dir)) {
        New-Item -ItemType Directory -Path $dir | Out-Null
        Write-Host " Created directory: $dir" -ForegroundColor Green
    }
}

# 1. Package.json
$packageJson = @'
{
  "name": "dryer-vent-squad-dashboard",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint"
  },
  "dependencies": {
    "@neondatabase/serverless": "^0.9.0",
    "@supabase/supabase-js": "^2.39.0",
    "lucide-react": "^0.344.0",
    "next": "^14.1.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "recharts": "^2.12.0"
  },
  "devDependencies": {
    "autoprefixer": "^10.4.18",
    "postcss": "^8.4.35",
    "tailwindcss": "^3.4.1"
  }
}
'@
Set-Content -Path "package.json" -Value $packageJson

# 2. Environment Template (.env.example)
$envExample = @'
NEXT_PUBLIC_SUPABASE_URL=https://your-supabase-id.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
DATABASE_URL=postgresql://postgres:password@your-supabase-host:5432/postgres
JOBBER_CLIENT_ID=your_jobber_client_id
JOBBER_CLIENT_SECRET=your_jobber_client_secret
JOBBER_REDIRECT_URI=https://your-app.vercel.app/api/jobber/oauth/callback
NEXT_PUBLIC_APP_URL=https://your-app.vercel.app
'@
Set-Content -Path ".env.example" -Value $envExample

Write-Host "`n✅ Dryer Vent Squad Project Files Created!" -ForegroundColor Green
Write-Host "👉 Next step: Run 'npm install' to load dependencies." -ForegroundColor Yellow
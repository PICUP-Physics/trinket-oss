# Getting Started with Trinket

This guide will help you get Trinket running locally for development.

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- Git

That's it! Everything else runs inside Docker.

## Quick Start

```bash
# Clone the repository
git clone https://github.com/trinketapp/trinket-oss.git
cd trinket-oss

# Copy the example local config
cp config/local.example.yaml config/local.yaml

# Start the services
docker-compose up
```

Wait for the services to start. You'll see `Server started on port:` when ready.

Open **http://localhost:3001** in your browser.

## Frontend Components

Trinket requires frontend libraries (Ace Editor, Skulpt, etc.) that are distributed separately from the main repository. These are packaged in `public-components.tgz` and downloaded automatically during the Docker build from GitHub releases.

**Skulpt** is the Python-to-JavaScript compiler that powers the Python code execution in the browser. Trinket maintains a forked version with additional features.

For local development, Docker handles everything automatically.

## Development

### Building CSS

The project uses SCSS for stylesheets. To compile:

```bash
# One-time build
docker-compose exec app npm run build:css

# Watch mode (recompiles on changes)
docker-compose exec app npm run watch:css
```

### Viewing Logs

```bash
# All services
docker-compose logs -f

# Just the app
docker logs -f trinket-gcr
```

### Restarting the App

```bash
docker-compose restart app
```

### Creating an Admin User

After registering a user through the web interface, promote them to admin:

```bash
docker-compose exec app npm run make-admin user@example.com
```

Admin users can access `/admin` for site administration features.

## Project Structure

```
trinket-oss/
├── app.js              # Main application entry point
├── config/             # Configuration files
│   ├── default.yaml    # Default settings
│   ├── local.yaml      # Your local overrides (gitignored)
│   ├── routes.js       # Web routes
│   └── api_routes.js   # API routes
├── lib/
│   ├── controllers/    # Route handlers
│   ├── models/         # MongoDB models
│   ├── util/           # Utilities
│   └── views/          # Nunjucks templates
├── public/             # Static assets (CSS, JS, images)
├── static/scss/        # SCSS source files
└── docker-compose.yml  # Docker services
```

## Services

| Service | Port | Description |
|---------|------|-------------|
| app | 3001 | Trinket web application (host port; container listens on 3000) |
| mongodb | 17017 | MongoDB database |
| redis | 16379 | Redis (optional - uses in-memory fallback if disabled) |
| nginx | 443 | HTTPS proxy (optional) |

## Troubleshooting

### CSS not loading?

Run the CSS build:
```bash
docker-compose exec app npm run build:css
```

### Container won't start?

Check logs:
```bash
docker-compose logs app
```

### Need to rebuild the container?

```bash
docker-compose build app
docker-compose up -d
```

---

# Configuration

Trinket is configured via YAML files in the `config/` directory.

| File | Purpose |
|------|---------|
| `default.yaml` | Base configuration (committed) |
| `local.yaml` | Local overrides (gitignored) |
| `production.yaml` | Production overrides (gitignored) |

Create `config/local.yaml` to override settings:

```yaml
app:
  plugins:
    session:
      cookieOptions:
        password: 'your-32-character-secret-here!!'
```

## Email (SMTP)

Email is required for password reset and notifications. Configure any SMTP provider:

```yaml
app:
  mail:
    from: 'noreply@example.com'
    host: 'smtp.example.com'
    port: 587
    user: 'your-smtp-username'
    pass: 'your-smtp-password'
    secure: false  # true for port 465
```

Common providers:

**Mailgun:**
```yaml
app:
  mail:
    from: 'noreply@your-domain.com'
    host: 'smtp.mailgun.org'
    port: 587
    user: 'postmaster@your-domain.com'
    pass: 'your-mailgun-smtp-password'
```

**SendGrid:**
```yaml
app:
  mail:
    from: 'noreply@example.com'
    host: 'smtp.sendgrid.net'
    port: 587
    user: 'apikey'
    pass: 'your-sendgrid-api-key'
```

Without email configured, password reset won't work. Users can still register, log in, and use all coding features.

## File Storage (AWS S3)

S3 is required for user-uploaded assets (images in trinkets). Without it, the asset upload feature is disabled.

```yaml
features:
  assets: true

aws:
  keyId: 'AKIAIOSFODNN7EXAMPLE'
  key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
  region: 'us-east-1'
  buckets:
    userassets:
      name: 'my-trinket-assets'
      host: 'https://my-trinket-assets.s3.amazonaws.com'
```

For S3-compatible storage (MinIO, DigitalOcean Spaces), add an `endpoint`:

```yaml
aws:
  endpoint: 'https://minio.example.com'
```

## Server-Side Languages

Python 3, Java, R, and Pygame require backend services. See [serverside/README.md](serverside/README.md) for setup.

Quick start:
```bash
cd serverside
docker compose --profile python3 up --build
```

Enable in config:
```yaml
features:
  trinkets:
    python3: true
    java: true
    R: true
    pygame: true

app:
  serverside:
    python3:
      api:
        default: 'http://localhost:8080/python3'
```

## Google OAuth

Allow users to sign in with Google:

1. Create OAuth credentials at [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Add authorized redirect URI: `https://your-domain.com/auth/google/callback`
3. Configure:

```yaml
app:
  auth:
    google:
      clientID: 'your-google-client-id.apps.googleusercontent.com'
      clientSecret: 'your-google-client-secret'
```

## reCAPTCHA

Protect forms from spam:

1. Get keys at [Google reCAPTCHA](https://www.google.com/recaptcha/admin)
2. Choose reCAPTCHA v2 "I'm not a robot"
3. Configure:

```yaml
app:
  recaptcha:
    sitekey: 'your-site-key'
    secretkey: 'your-secret-key'
```

## Branding

Customize the site appearance:

```yaml
app:
  siteName: 'My Code School'
  logo: '/img/my-logo.png'
  logoIcon: '/img/my-logo-icon.png'
  supportEmail: 'support@example.com'
```

Place logo files in `public/img/`.

## Feature Flags

Enable/disable trinket types:

```yaml
features:
  trinkets:
    python: true      # Skulpt (browser-based)
    python3: false    # Server-side
    pygame: false     # Server-side
    html: true        # Browser-based
    java: false       # Server-side
    R: false          # Server-side
    glowscript: true  # Browser-based (3D)
    blocks: false     # Visual blocks
    music: false      # EarSketch
```

Other features:
```yaml
features:
  courses: true              # Course/LMS features
  assets: false              # File uploads (requires S3)
  accessibilityToggle: false # Show accessibility toggle
```

## Redis (Optional)

Redis is **completely optional**. When disabled, the application uses an in-memory store for caching. This works fine for development and small deployments.

For production with multiple app instances or better performance, enable Redis:

```yaml
db:
  redis:
    enabled: true
    app:
      host: 'localhost'
      port: 6379
      pass: ''
```

Without Redis, cache data is lost on restart and not shared between instances.

## Production Checklist

- [ ] Set strong session cookie password (32+ chars)
- [ ] Configure email for password reset
- [ ] Set up HTTPS (required for secure cookies)
- [ ] Configure `app.url` to match your domain
- [ ] Review feature flags

# Omnivore to Readwise Exporter


A TypeScript script that exports your Omnivore articles to Readwise. The script checks for existing articles to avoid duplicates and includes caching to minimize API calls.

## Features

- 📚 Exports articles from Omnivore to Readwise
- 🔄 Avoids duplicate articles
- ⚡ Caches responses to minimize API calls
- 🚫 Skips Substack and Omnivore URLs automatically
- 📊 Progress bar with time estimates
- 🏃‍♂️ Dry run mode for testing

## Prerequisites
- Node.js (v14 or higher recommended)
- pnpm (or npm/yarn)
- Omnivore cookie from browser (https://docs.omnivore.app/integrations/api.html#saving-requests-from-the-browser) (Starts with `auth=eyJ...`)
- Readwise API token (https://readwise.io/reader_api)

## Installation

1. Clone this repository
```
git clone https://github.com/briansunter/omnivore-to-readwise-exporter.git
```
2. Install dependencies: 
```
pnpm install
```
3. Create a `.env` file in the root directory:
```bash
OMNIVORE_COOKIE=your_omnivore_cookie
READWISE_TOKEN=your_reader_api_token
```

## Usage

### Basic Usage
```bash
pnpm start
```

### Dry Run Mode
Test without exporting articles:
```bash
pnpm start --dry-run
```

### Force Refresh
Bypass cache and fetch fresh data:
```bash
pnpm start --force
```

## How It Works

### Caching
- Creates two cache files:
  - `omnivore_articles.csv`: Stores Omnivore article data
  - `readwise_articles.csv`: Stores Reader article data
- Default cache duration: 7 days
- Use `--force` flag to bypass cache

### URL Handling
- Automatically skips:
  - Substack URLs
  - Omnivore app URLs
  - Previously exported articles
- Validates URLs before processing

### Rate Limiting
- 3-second delay between API calls
- Automatic handling of rate limit responses
- Up to 3 retries for failed requests

### Progress Tracking
- Real-time progress bar
- Estimated time remaining
- Processing rate (articles/minute)
- Success/failure counts

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `OMNIVORE_COOKIE` | Omnivore authentication cookie | `auth=eyJ...` |
| `READWISE_TOKEN` | Reader API access token | `00000000-0000-0000-0000-000000000000` |

## Troubleshooting

### Common Issues

1. **Authentication Errors**
   - Verify your environment variables are set correctly
   - Check if your tokens have expired

2. **Rate Limiting**
   - The script handles rate limits automatically
   - Wait for the cooldown period to complete

3. **Cache Issues**
   - Delete cache files and retry
   - Use `--force` flag for fresh data

### Debug Mode
Add `DEBUG=1` to enable verbose logging:
```bash
DEBUG=1 pnpm start
```

## Development

### Project Structure
```
.
├── export.ts         # Main script
├── .env             # Environment variables
├── package.json     # Dependencies
└── README.md        # Documentation
```

### Dependencies
- `graphql-request`: GraphQL client
- `axios`: HTTP client
- `cli-progress`: Progress bar
- `dotenv`: Environment configuration
- `csv-parse/sync`: CSV parsing
- `csv-stringify/sync`: CSV generation

## Contributing

1. Fork the repository
2. Create a feature branch
3. Submit a pull request

## License

MIT License - See LICENSE file for details
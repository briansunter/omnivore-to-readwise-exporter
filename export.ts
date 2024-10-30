// export.ts

import { GraphQLClient, gql } from 'graphql-request';
import axios from 'axios';
import * as dotenv from 'dotenv';
import cliProgress from 'cli-progress';
import * as process from 'process';
import * as fs from 'fs';
import * as csv from 'csv-parse/sync';
import * as csvStringify from 'csv-stringify/sync';
import chalk from 'chalk';
import { existsSync } from 'fs';

dotenv.config();

// Add the cookie from environment variable
const OMNIVORE_COOKIE = process.env.OMNIVORE_COOKIE;

// Sleep function to respect rate limits
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ReadwiseArticle {
  id: string;
  url: string;
  source_url: string;
  title: string;
  author?: string;
  source?: string;
  category?: string;
  location?: string;
  tags?: string[];
  site_name?: string;
  word_count?: number;
  created_at: string;
  updated_at: string;
  notes?: string;
  published_date?: string;
  summary?: string;
  image_url?: string;
  reading_progress?: number;
}

async function handleRateLimit(error: any): Promise<void> {
  if (error.response?.status === 429) {
    const retryAfter = error.response.headers['retry-after'];
    const waitTime = (retryAfter ? parseInt(retryAfter) : 60) * 1000; // Convert to milliseconds
    console.log(`Rate limited. Waiting ${waitTime/1000} seconds before retrying...`);
    await sleep(waitTime);
  } else {
    throw error;
  }
}

interface ReadwiseResponse {
  results: ReadwiseArticle[];
  nextPageCursor: string | null;
}

interface ReadwiseClient {
  get(path: string, config?: any): Promise<any>;
  post(path: string, data: SaveArticlePayload): Promise<any>;
}

async function fetchReadwiseArticles(
  readwiseClient: ReadwiseClient,
  progressBar?: cliProgress.SingleBar
): Promise<ReadwiseArticle[]> {
  const forceRefresh = process.argv.includes('--force');
  
  console.log(chalk.blue('\n🔍 Checking Readwise authentication...'));
  // First check token
  try {
    await readwiseClient.get('v2/auth/');
    console.log(chalk.green('✓ Readwise authentication successful'));
  } catch (error: any) {
    if (error.response?.status === 401) {
      throw new Error('Invalid Readwise token. Please check your READWISE_TOKEN in .env');
    }
    console.error(chalk.red('Error checking Readwise authentication:'), error);
    throw error;
  }

  // Check cache first
  if (existsSync(READWISE_CACHE_FILE) && !forceRefresh) {
    console.log(chalk.blue('📂 Readwise articles cache exists'));
    const cachedData = await loadFromCache<ReadwiseArticle>(READWISE_CACHE_FILE);
    if (cachedData && cachedData.articles.length > 0) {
      console.log(chalk.green(`✓ Using cached data with ${cachedData.articles.length} articles`));
      if (progressBar) {
        progressBar.update(2, { status: `${cachedData.articles.length} articles (cached)` });
      }
      return cachedData.articles;
    }
    console.log(chalk.yellow('Cache is empty. Fetching fresh data...'));
  }

  console.log(chalk.blue('\n📥 Fetching articles from Readwise...'));
  let articles: ReadwiseArticle[] = [];
  let nextCursor: string | null = null;
  let retryCount = 0;
  const maxRetries = 3;
  let pageCount = 0;
  
  do {
    try {
      pageCount++;
      console.log(chalk.blue(`Fetching page ${pageCount} (${articles.length} articles so far)...`));

      if (progressBar) {
        progressBar.update(1, { status: `${articles.length} articles...` });
      }

      const response = await readwiseClient.get('v3/list/', {
        params: {
          ...(nextCursor && { pageCursor: nextCursor }),
          category: 'article'
        }
      });
      
      const newArticles = response.data.results;
      console.log(chalk.green(`✓ Retrieved ${newArticles.length} articles from page ${pageCount}`));
      
      articles = articles.concat(newArticles);
      nextCursor = response.data.nextPageCursor;
      
      if (nextCursor) {
        console.log(chalk.blue('Waiting 3 seconds before next request (rate limit)...'));
        await sleep(3000);
      }
      
      retryCount = 0;
      
    } catch (error: any) {
      console.error(chalk.red(`Error on page ${pageCount}:`), error.message);
      if (error.response?.status === 429) {
        const retryAfter = error.response.headers['retry-after'] || '60';
        const waitTime = parseInt(retryAfter) * 1000;
        console.log(chalk.yellow(`⏳ Rate limited. Waiting ${waitTime/1000} seconds...`));
        await sleep(waitTime);
        retryCount++;
        if (retryCount <= maxRetries) {
          console.log(chalk.blue(`Retrying page ${pageCount} (attempt ${retryCount}/${maxRetries})...`));
          continue;
        }
      }
      throw error;
    }
  } while (nextCursor);

  console.log(chalk.green(`\n✓ Successfully fetched ${articles.length} articles from Readwise`));
  await saveToCache(READWISE_CACHE_FILE, articles);
  
  if (progressBar) {
    progressBar.update(2, { status: `${articles.length} articles` });
  }
  return articles;
}

// Simplified interface with only needed fields
interface OmnivoreArticle {
  id: string;
  title: string;
  url: string;
  author?: string;
  publishedAt?: string;
  createdAt: string;
  article?: {
    content: string;
  };
}

interface SearchResponse {
  search: {
    edges: Array<{
      cursor: string;
      node: OmnivoreArticle;
    }>;
    pageInfo: {
      hasNextPage: boolean;
      hasPreviousPage: boolean;
      startCursor: string;
      endCursor: string;
    };
  };
}

const OMNIVORE_CACHE_FILE = 'omnivore_articles.csv';
const READWISE_CACHE_FILE = 'readwise_articles.csv';

interface CachedData<T> {
  timestamp: number;
  articles: T[];
}

// Add this interface for cached records
interface CachedRecord {
  metadata?: string;
}

// Update loadFromCache to be simpler
async function loadFromCache<T extends { [key: string]: any }>(filename: string): Promise<CachedData<T> | null> {
  try {
    if (!fs.existsSync(filename)) {
      console.log(chalk.yellow(`Cache file ${filename} does not exist`));
      return null;
    }

    const fileContent = fs.readFileSync(filename, 'utf-8');
    const records = csv.parse(fileContent, { columns: true }) as (T & CachedRecord)[];
    
    // Get metadata from first record
    const metadataRecord = records[0];
    
    if (!metadataRecord || !('metadata' in metadataRecord)) {
      console.log(chalk.yellow('No metadata found in cache'));
      return null;
    }

    const articles = records.slice(1) as T[];
    console.log(chalk.blue(`Found ${articles.length} articles in cache`));

    if (articles.length === 0) {
      console.log(chalk.yellow('No articles found in cache'));
      return null;
    }

    return {
      timestamp: Date.now(), // Timestamp doesn't matter anymore but keeping for interface compatibility
      articles
    };
  } catch (error) {
    console.error(chalk.red('\nError loading cache:'), error);
    return null;
  }
}

async function saveToCache<T extends { [key: string]: any }>(filename: string, articles: T[]): Promise<void> {
  try {
    console.log(chalk.blue('\nSaving to cache...'));
    
    // Create metadata record
    const timestamp = Date.now();
    const metadata = { timestamp };
    console.log(chalk.blue('Created metadata:'), metadata);
    
    // Prepare records with metadata
    const articlesWithMetadata: ({ metadata: string } | { [key: string]: any })[] = [
      { metadata: JSON.stringify(metadata) }
    ];

    // Clean articles
    const cleanArticles = articles.map(article => {
      const cleanArticle: { [key: string]: any } = {};
      Object.entries(article).forEach(([key, value]) => {
        if (value !== undefined) {
          cleanArticle[key] = value;
        }
      });
      return cleanArticle;
    });

    articlesWithMetadata.push(...cleanArticles);
    
    // Get columns
    const columns = new Set<string>();
    columns.add('metadata');
    cleanArticles.forEach(article => {
      Object.keys(article).forEach(key => columns.add(key));
    });
    
    console.log(chalk.blue('Columns in CSV:'), Array.from(columns));
    
    const csvContent = csvStringify.stringify(articlesWithMetadata, {
      header: true,
      columns: Array.from(columns)
    });

    // Debug first few lines
    console.log(chalk.blue('\nFirst 500 characters of generated CSV:'));
    console.log(csvContent.substring(0, 500));
    
    fs.writeFileSync(filename, csvContent);
    console.log(chalk.green(`\n✅ Cached ${articles.length} articles to ${filename}`));
    console.log(chalk.blue(`Cache timestamp set to: ${new Date(timestamp).toISOString()}`));
  } catch (error) {
    console.error(chalk.red('\nError saving cache:'), error);
  }
}

async function fetchOmnivoreArticles(omnivoreClient: GraphQLClient): Promise<OmnivoreArticle[]> {
  const forceRefresh = process.argv.includes('--force');
  
  console.log(chalk.blue('Checking Omnivore cache...'));
  
  // Check if we can use cache
  if (existsSync(OMNIVORE_CACHE_FILE) && !forceRefresh) {
    try {
      const fileContent = fs.readFileSync(OMNIVORE_CACHE_FILE, 'utf-8');
      const records = csv.parse(fileContent, { columns: true }) as (OmnivoreArticle & CachedRecord)[];
      const articles = records.slice(1) as OmnivoreArticle[];
      console.log(chalk.blue(`Using cached data with ${articles.length} articles`));
      return articles;
    } catch (error) {
      console.log(chalk.yellow('Error reading cache:', error));
    }
  }

  // If we get here, we need to fetch fresh data
  console.log(chalk.blue('Fetching fresh data from Omnivore...'));

  const searchQuery = gql`
    query Search($after: String, $first: Int, $query: String) {
      search(first: $first, after: $after, query: $query) {
        ... on SearchSuccess {
          edges {
            cursor
            node {
              id
              title
              url
              author
              publishedAt
              createdAt
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
        ... on SearchError {
          errorCodes
        }
      }
    }
  `;

  let articles: OmnivoreArticle[] = [];
  let hasNextPage = true;
  let after: string | null = "0";
  
  while (hasNextPage) {
    try {
      const variables = {
        after,
        first: 100,
        query: "in:inbox use:folders"
      };

      console.log(chalk.blue(`Omnivore: ${articles.length} articles...`));

      const data = await omnivoreClient.request<SearchResponse>(searchQuery, variables);
      
      if (!data.search || !('edges' in data.search)) {
        throw new Error('Invalid response from Omnivore API');
      }
      
      const newArticles = data.search.edges.map(edge => edge.node);
      articles = articles.concat(newArticles);
      
      hasNextPage = data.search.pageInfo.hasNextPage;
      after = data.search.pageInfo.endCursor;
      
      await sleep(1000);
      
    } catch (error) {
      throw new Error(`Failed to fetch articles from Omnivore: ${error}`);
    }
  }

  await saveToCache(OMNIVORE_CACHE_FILE, articles);
  console.log(chalk.blue(`Omnivore: ${articles.length} articles total`));
  return articles;
}

// Update the findNewArticles function to skip Substack and Omnivore URLs
function findNewArticles(omnivoreArticles: OmnivoreArticle[], readwiseArticles: ReadwiseArticle[]): OmnivoreArticle[] {
  console.log(chalk.blue('\nDebug: URL Comparison'));
  console.log('First few Readwise URLs:');
  
  let loggedCount = 0;
  const readwiseUrls = new Set<string>();
  
  readwiseArticles.forEach(article => {
    try {
      if (article.url) {
        const normalizedUrl = new URL(article.url).toString().toLowerCase().replace(/\/+$/, '');
        readwiseUrls.add(normalizedUrl);
        
        if (loggedCount < 5) {
          console.log(`Original url: ${article.url}`);
          console.log(`Normalized: ${normalizedUrl}`);
          loggedCount++;
        }
      }
      if (article.source_url) {
        const normalizedSourceUrl = new URL(article.source_url).toString().toLowerCase().replace(/\/+$/, '');
        readwiseUrls.add(normalizedSourceUrl);
        
        if (loggedCount < 5) {
          console.log(`Original source_url: ${article.source_url}`);
          console.log(`Normalized: ${normalizedSourceUrl}`);
          loggedCount++;
        }
      }
    } catch (e) {
      if (article.url) {
        const normalizedUrl = article.url.toLowerCase().replace(/\/+$/, '');
        readwiseUrls.add(normalizedUrl);
      }
      if (article.source_url) {
        const normalizedSourceUrl = article.source_url.toLowerCase().replace(/\/+$/, '');
        readwiseUrls.add(normalizedSourceUrl);
      }
    }
  });

  console.log(`\nTotal Readwise URLs: ${readwiseUrls.size}`);
  console.log('First few Omnivore URLs:');

  loggedCount = 0;
  let skippedSubstack = 0;
  let skippedOmnivore = 0;

  // Filter Omnivore articles that don't exist in Readwise and aren't from Substack or Omnivore
  const newArticles = omnivoreArticles.filter(article => {
    try {
      const url = new URL(article.url);
      const hostname = url.hostname.toLowerCase();
      
      // Skip Substack and Omnivore URLs
      if (hostname.includes('substack.com')) {
        skippedSubstack++;
        return false;
      }
      if (hostname.includes('omnivore.app')) {
        skippedOmnivore++;
        return false;
      }

      const normalizedUrl = url.toString().toLowerCase().replace(/\/+$/, '');
      const isDuplicate = readwiseUrls.has(normalizedUrl);
      
      if (loggedCount < 5) {
        console.log(`Original: ${article.url}`);
        console.log(`Normalized: ${normalizedUrl}`);
        console.log(`Is duplicate: ${isDuplicate}`);
        loggedCount++;
      }
      
      return !isDuplicate;
    } catch (e) {
      const normalizedUrl = article.url.toLowerCase().replace(/\/+$/, '');
      
      // Skip Substack and Omnivore URLs even if URL parsing fails
      if (normalizedUrl.includes('substack.com')) {
        skippedSubstack++;
        return false;
      }
      if (normalizedUrl.includes('omnivore.app')) {
        skippedOmnivore++;
        return false;
      }

      const isDuplicate = readwiseUrls.has(normalizedUrl);
      
      if (loggedCount < 5) {
        console.log(`Original (failed parse): ${article.url}`);
        console.log(`Normalized (failed parse): ${normalizedUrl}`);
        console.log(`Is duplicate: ${isDuplicate}`);
        loggedCount++;
      }
      
      return !isDuplicate;
    }
  });

  console.log(`\nSkipped ${skippedSubstack} Substack articles`);
  console.log(`Skipped ${skippedOmnivore} Omnivore articles`);
  console.log(`Found ${omnivoreArticles.length - newArticles.length - skippedSubstack - skippedOmnivore} duplicates`);
  
  return newArticles;
}

// New interface for saving articles
interface SaveArticlePayload {
  url: string;
  html?: string;
  should_clean_html?: boolean;
  title?: string;
  author?: string;
  summary?: string;
  published_date?: string;
  image_url?: string;
  location?: 'new' | 'later' | 'archive' | 'feed';
  category?: 'article' | 'email' | 'rss' | 'highlight' | 'note' | 'pdf' | 'epub' | 'tweet' | 'video';
  saved_using?: string;
  tags?: string[];
  notes?: string;
}

// First add a function to validate URLs
function isValidUrl(urlString: string): boolean {
  try {
    new URL(urlString);
    return true;
  } catch (e) {
    return false;
  }
}

// Update the saveToReadwise function to handle Axios responses correctly
async function saveToReadwise(
  readwiseClient: ReadwiseClient,
  article: OmnivoreArticle
): Promise<void> {
  // Validate and clean the URL first
  if (!isValidUrl(article.url)) {
    throw new Error(`Invalid URL: ${article.url}`);
  }

  // Format the published date according to ISO 8601 if it exists
  let publishedDate: string | undefined;
  if (article.publishedAt) {
    try {
      publishedDate = new Date(article.publishedAt).toISOString();
    } catch (e) {
      console.log(chalk.yellow(`Warning: Invalid published date for "${article.title}"`));
    }
  }

  // Prepare the payload according to Readwise API specs
  const payload: SaveArticlePayload = {
    url: article.url,
    title: article.title || undefined,
    author: article.author || undefined,
    published_date: publishedDate,
    category: 'article',
    location: 'new',
    saved_using: 'omnivore-export',
    tags: ['omnivore-import'],
    should_clean_html: true
  };

  // Remove any undefined values
  Object.keys(payload).forEach(key => {
    if (payload[key as keyof SaveArticlePayload] === undefined) {
      delete payload[key as keyof SaveArticlePayload];
    }
  });

  try {
    // Make the request directly with axios
    const response = await readwiseClient.post('v3/save/', payload);
    
    // Log success details
    console.log(chalk.green(`\n✓ Successfully saved article: ${article.title}`));
    console.log(chalk.blue('Response status:', response.status));

  } catch (error: any) {
    // Enhanced error handling
    if (error.response?.status === 429) {
      console.log(chalk.yellow('\nRate limit hit, waiting...'));
      await handleRateLimit(error);
      // Retry once after rate limit
      return await saveToReadwise(readwiseClient, article);
    }

    // Log detailed error information
    console.log(chalk.red('\nError details:'));
    console.log('Article:', {
      url: article.url,
      title: article.title,
      author: article.author,
      publishedAt: article.publishedAt
    });
    console.log('Payload:', JSON.stringify(payload, null, 2));
    
    if (error.response) {
      console.log('Response status:', error.response.status);
      console.log('Response data:', error.response.data);
      throw new Error(`Readwise API error (${error.response.status}): ${JSON.stringify(error.response.data)}`);
    } else if (error.request) {
      console.log('No response received');
      console.log('Request:', error.request);
      throw new Error('No response received from Readwise API');
    } else {
      console.log('Error:', error.message);
      throw error;
    }
  }
}

// Add this interface near the top with other interfaces
interface ProgressStats {
  startTime: number;
  processedCount: number;
  successCount: number;
  failureCount: number;
  recentTimes: number[];
}

// Update the formatTimeRemaining function to be more precise
function formatTimeRemaining(stats: ProgressStats, totalCount: number): string {
  const elapsed = Date.now() - stats.startTime;
  const itemsRemaining = totalCount - stats.processedCount;
  
  if (stats.processedCount === 0) {
    return 'Calculating...';
  }
  
  // Calculate average time per item using recent times
  const avgTimePerItem = stats.recentTimes.length > 0 
    ? stats.recentTimes.reduce((a, b) => a + b, 0) / stats.recentTimes.length
    : elapsed / stats.processedCount;

  const estimatedTimeRemaining = itemsRemaining * avgTimePerItem;
  
  // Format time remaining in a human readable way
  if (estimatedTimeRemaining < 1000) {
    return '< 1 second';
  }

  const parts: string[] = [];
  
  // Calculate time units
  const hours = Math.floor(estimatedTimeRemaining / 3600000);
  const minutes = Math.floor((estimatedTimeRemaining % 3600000) / 60000);
  const seconds = Math.floor((estimatedTimeRemaining % 60000) / 1000);
  
  // Add each non-zero unit to parts array
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}s`);
  }
  
  // Calculate rate (articles per minute)
  const rate = (stats.processedCount / (elapsed / 60000));
  const rateStr = rate < 0.1 ? '< 0.1' : rate.toFixed(1);
  
  return `${parts.join(' ')} (${rateStr}/min)`;
}

// Update the progress bar format in main()
const exportBar = new cliProgress.SingleBar({
  format: 'Export Progress | {bar} | {percentage}% | {value}/{total} articles | {timeRemaining} | {title}',
  barCompleteChar: '█',
  barIncompleteChar: '░',
  hideCursor: true
});

// Replace the main function with this improved version
async function main() {
  try {
    const isDryRun = process.argv.includes('--dry-run');
    
    if (!OMNIVORE_COOKIE) {
      console.error(chalk.red('❌ Please set OMNIVORE_COOKIE in your .env file.'));
      process.exit(1);
    }

    if (!process.env.READWISE_TOKEN) {
      console.error(chalk.red('❌ Please set READWISE_TOKEN in your .env file.'));
      process.exit(1);
    }

    const omnivoreClient = new GraphQLClient('https://api-prod.omnivore.app/api/graphql', {
      headers: {
        'Content-Type': 'application/json',
        'Cookie': OMNIVORE_COOKIE,
      },
    });

    const readwiseClient = axios.create({
      baseURL: 'https://readwise.io/api/',
      headers: {
        'Authorization': `Token ${process.env.READWISE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      // Add timeout and validation
      timeout: 10000,
      validateStatus: (status) => {
        return status >= 200 && status < 300;
      }
    }) as ReadwiseClient;

    console.log(chalk.blue('\n📚 Fetching articles...'));
    
    // Fetch articles
    const omnivoreArticles = await fetchOmnivoreArticles(omnivoreClient);
    const readwiseArticles = await fetchReadwiseArticles(readwiseClient);

    const newArticles = findNewArticles(omnivoreArticles, readwiseArticles);
    
    console.log(chalk.yellow('\n📊 Export Statistics'));
    console.log(chalk.yellow('-------------------'));
    console.log(`Omnivore articles: ${chalk.green(omnivoreArticles.length)}`);
    console.log(`Readwise articles: ${chalk.green(readwiseArticles.length)}`);
    console.log(`New articles to import: ${chalk.green(newArticles.length)}`);

    if (isDryRun) {
      console.log(chalk.yellow('\n🏃 Dry run completed. Remove --dry-run flag to perform the actual export.'));
      if (newArticles.length > 0) {
        console.log(chalk.cyan('\nSummary:'));
        console.log(`Will add: ${chalk.green(newArticles.length)} new articles`);
        console.log(`Skipping: ${chalk.yellow(omnivoreArticles.length - newArticles.length)} duplicate articles`);
      }
      return;
    }

    if (newArticles.length === 0) {
      console.log(chalk.green('\n✨ No new articles to export.'));
      return;
    }

    // Export progress bar
    const exportBar = new cliProgress.SingleBar({
      format: 'Export Progress | {bar} | {percentage}% | {value}/{total} articles | {timeRemaining} | {title}',
      barCompleteChar: '█',
      barIncompleteChar: '░',
      hideCursor: true
    });

    const stats: ProgressStats = {
      startTime: Date.now(),
      processedCount: 0,
      successCount: 0,
      failureCount: 0,
      recentTimes: [] // Store last 5 processing times
    };

    exportBar.start(newArticles.length, 0, { 
      title: 'Starting export...',
      timeRemaining: 'Calculating...'
    });

    for (const [index, article] of newArticles.entries()) {
      const itemStartTime = Date.now();
      
      try {
        const timeRemaining = formatTimeRemaining(stats, newArticles.length);
        exportBar.update(index, { 
          title: chalk.yellow(`${article.title?.substring(0, 30)}...`),
          timeRemaining: timeRemaining
        });

        await saveToReadwise(readwiseClient, article);
        stats.successCount++;
        
        // Track processing time
        const processingTime = Date.now() - itemStartTime;
        stats.recentTimes.push(processingTime);
        if (stats.recentTimes.length > 5) {
          stats.recentTimes.shift();
        }
        
        await sleep(3000);
      } catch (error: any) {
        stats.failureCount++;
        console.error(`\n${chalk.red('❌')} Failed to process "${article.title}":`);
        console.error(chalk.red(error.message));
        
        // Add a delay after errors
        await sleep(1000);
      }
      
      stats.processedCount++;
      exportBar.increment({ timeRemaining: formatTimeRemaining(stats, newArticles.length) });
    }

    exportBar.stop();

    // Final summary
    console.log(chalk.yellow('\n📊 Export Results'));
    console.log(chalk.yellow('---------------'));
    console.log(`Successfully processed: ${chalk.green(stats.successCount)} articles`);
    console.log(`Failed to process: ${chalk.red(stats.failureCount)} articles`);
    console.log(chalk.green('\n✨ Export completed!'));
    
  } catch (error: any) {
    console.error(chalk.red('\n❌ An error occurred:'), error.message);
    process.exit(1);
  }
}

// Replace the IIFE with a simple main() call
main();

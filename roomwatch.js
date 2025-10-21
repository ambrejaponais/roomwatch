#!/usr/bin/env node

/**
 * roomwatch - Room vacancy monitoring with Claude AI and push notifications
 */

const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

// Configure logging
const LOG_LEVEL = process.env.LOG_LEVEL || 'INFO';

const logger = {
  debug: (...args) => LOG_LEVEL === 'DEBUG' && console.log('[DEBUG]', ...args),
  info: (...args) => ['DEBUG', 'INFO'].includes(LOG_LEVEL) && console.log('[INFO]', ...args),
  warning: (...args) => console.warn('[WARNING]', ...args),
  error: (...args) => console.error('[ERROR]', ...args)
};

/**
 * Main RoomWatch class
 */
class RoomWatch {
  constructor() {
    this.claudeApiKey = process.env.CLAUDE_API_KEY;
    this.pushoverToken = process.env.PUSHOVER_TOKEN;
    this.pushoverUser = process.env.PUSHOVER_USER;
    this.targetUrl = process.env.TARGET_URL;
    this.stateFile = process.env.STATE_FILE || 'state.json';

    // Validate configuration
    this.validateConfig();

    // Initialize Claude client
    this.claudeClient = new Anthropic({
      apiKey: this.claudeApiKey
    });
  }

  /**
   * Validate required configuration
   */
  validateConfig() {
    const required = {
      CLAUDE_API_KEY: this.claudeApiKey,
      PUSHOVER_TOKEN: this.pushoverToken,
      PUSHOVER_USER: this.pushoverUser,
      TARGET_URL: this.targetUrl
    };

    const missing = Object.entries(required)
      .filter(([, value]) => !value)
      .map(([key]) => key);

    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
  }

  /**
   * Fetch the target webpage
   * @returns {Promise<string>} HTML content
   */
  async fetchWebpage() {
    logger.info(`Fetching webpage: ${this.targetUrl}`);
    try {
      const response = await axios.get(this.targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 30000
      });
      logger.info('Webpage fetched successfully');
      return response.data;
    } catch (error) {
      logger.error(`Failed to fetch webpage: ${error.message}`);
      throw error;
    }
  }

  /**
   * Extract relevant content from HTML
   * @param {string} html - Raw HTML content
   * @returns {string} Cleaned text content
   */
  extractContent(html) {
    logger.info('Extracting content from HTML');
    const $ = cheerio.load(html);

    // Remove unwanted elements
    $('script, style, nav, footer, header').remove();

    // Get text content
    const text = $('body').text();

    // Clean up whitespace
    const lines = text
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);

    const content = lines.join('\n');

    logger.info(`Extracted ${content.length} characters of content`);
    return content;
  }

  /**
   * Use Claude to analyze vacancy information
   * @param {string} content - Webpage content
   * @returns {Promise<Object>} Vacancy data
   */
  async summarizeWithClaude(content) {
    logger.info('Analyzing content with Claude AI');

    const prompt = `Analyze the following room vacancy webpage content and extract key information.

Please provide:
1. A summary of available rooms (room numbers, types, prices if available)
2. Total number of vacancies
3. Any important details (move-in dates, requirements, etc.)
4. Whether rooms appear to be available or not

Format your response as JSON with this structure:
{
    "has_vacancies": true/false,
    "vacancy_count": number,
    "summary": "brief summary text",
    "rooms": [
        {"room": "room identifier", "details": "details"},
        ...
    ],
    "notes": "any additional important information"
}

Webpage content:
${content.substring(0, 4000)}
`;

    try {
      const message = await this.claudeClient.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: prompt }
        ]
      });

      // Extract text response
      const responseText = message.content[0].text;

      // Try to parse as JSON
      let result;
      try {
        result = JSON.parse(responseText);
      } catch {
        // If not valid JSON, wrap in basic structure
        result = {
          has_vacancies: responseText.toLowerCase().includes('available') ||
                        responseText.toLowerCase().includes('vacancy'),
          vacancy_count: 0,
          summary: responseText,
          rooms: [],
          notes: 'Could not parse structured data'
        };
      }

      logger.info(`Claude analysis complete: ${result.vacancy_count || 0} vacancies found`);
      return result;

    } catch (error) {
      logger.error(`Failed to analyze with Claude: ${error.message}`);
      throw error;
    }
  }

  /**
   * Load previous state from disk
   * @returns {Promise<Object|null>} Previous state or null
   */
  async loadPreviousState() {
    try {
      const stateExists = await fs.access(this.stateFile)
        .then(() => true)
        .catch(() => false);

      if (stateExists) {
        const data = await fs.readFile(this.stateFile, 'utf8');
        const state = JSON.parse(data);
        logger.info('Previous state loaded');
        return state;
      }
    } catch (error) {
      logger.warning(`Could not load previous state: ${error.message}`);
    }
    return null;
  }

  /**
   * Save current state to disk
   * @param {Object} state - State to save
   */
  async saveState(state) {
    try {
      state.last_check = new Date().toISOString();
      await fs.writeFile(this.stateFile, JSON.stringify(state, null, 2));
      logger.info('State saved successfully');
    } catch (error) {
      logger.error(`Failed to save state: ${error.message}`);
    }
  }

  /**
   * Determine if there are significant changes
   * @param {Object} current - Current vacancy data
   * @param {Object|null} previous - Previous vacancy data
   * @returns {boolean} True if changes detected
   */
  hasChanges(current, previous) {
    if (!previous) {
      logger.info('No previous state - treating as change');
      return true;
    }

    // Check if vacancy status changed
    if (current.has_vacancies !== previous.has_vacancies) {
      logger.info('Vacancy status changed');
      return true;
    }

    // Check if vacancy count changed
    if (current.vacancy_count !== previous.vacancy_count) {
      logger.info('Vacancy count changed');
      return true;
    }

    // Check if specific rooms changed
    const currentRooms = new Set(current.rooms?.map(r => r.room) || []);
    const previousRooms = new Set(previous.rooms?.map(r => r.room) || []);

    if (currentRooms.size !== previousRooms.size ||
        ![...currentRooms].every(room => previousRooms.has(room))) {
      logger.info('Room list changed');
      return true;
    }

    logger.info('No significant changes detected');
    return false;
  }

  /**
   * Send push notification via Pushover
   * @param {Object} vacancyData - Vacancy data
   */
  async sendNotification(vacancyData) {
    logger.info('Sending push notification');

    // Build notification message
    let title, message;

    if (vacancyData.has_vacancies) {
      title = '🏠 Room Vacancies Detected!';
      message = `${vacancyData.summary}\n\n`;

      if (vacancyData.rooms && vacancyData.rooms.length > 0) {
        message += 'Available rooms:\n';
        for (const room of vacancyData.rooms.slice(0, 5)) {
          message += `- ${room.room || 'N/A'}: ${room.details || 'No details'}\n`;
        }
      }

      if (vacancyData.notes) {
        message += `\n${vacancyData.notes}`;
      }
    } else {
      title = 'Room Watch Update';
      message = 'No vacancies currently available.\n\n' + (vacancyData.summary || '');
    }

    // Send via Pushover
    try {
      await axios.post('https://api.pushover.net/1/messages.json', {
        token: this.pushoverToken,
        user: this.pushoverUser,
        title: title,
        message: message.substring(0, 1024), // Pushover message length limit
        priority: vacancyData.has_vacancies ? 1 : 0,
        url: this.targetUrl,
        url_title: 'View Vacancies'
      });
      logger.info('Notification sent successfully');
    } catch (error) {
      logger.error(`Failed to send notification: ${error.message}`);
      throw error;
    }
  }

  /**
   * Main execution method
   * @returns {Promise<Object>} Current vacancy data
   */
  async run() {
    logger.info('Starting RoomWatch check');

    try {
      // Fetch and parse webpage
      const html = await this.fetchWebpage();
      const content = this.extractContent(html);

      // Analyze with Claude
      const vacancyData = await this.summarizeWithClaude(content);

      // Load previous state
      const previousState = await this.loadPreviousState();

      // Check for changes
      if (this.hasChanges(vacancyData, previousState)) {
        logger.info('Changes detected - sending notification');
        await this.sendNotification(vacancyData);
      } else {
        logger.info('No changes - skipping notification');
      }

      // Save current state
      await this.saveState(vacancyData);

      logger.info('RoomWatch check completed successfully');
      return vacancyData;

    } catch (error) {
      logger.error(`RoomWatch check failed: ${error.message}`);
      throw error;
    }
  }
}

/**
 * AWS Lambda handler function
 */
exports.handler = async (event, context) => {
  try {
    const watcher = new RoomWatch();
    const result = await watcher.run();

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'RoomWatch executed successfully',
        result: result
      })
    };
  } catch (error) {
    logger.error(`Lambda execution failed: ${error.message}`);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: 'RoomWatch execution failed',
        error: error.message
      })
    };
  }
};

/**
 * Main entry point for local execution
 */
async function main() {
  try {
    const watcher = new RoomWatch();
    const result = await watcher.run();

    console.log('\n' + '='.repeat(50));
    console.log('ROOMWATCH RESULTS');
    console.log('='.repeat(50));
    console.log(JSON.stringify(result, null, 2));
    console.log('='.repeat(50) + '\n');

    process.exit(0);
  } catch (error) {
    logger.error(`Execution failed: ${error.message}`);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

module.exports = { RoomWatch };

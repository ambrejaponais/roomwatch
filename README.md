# roomwatch

A personal automation tool that monitors room vacancy web pages, summarizes changes using Claude AI, and sends push notifications to your phone when vacancies are detected.

## Overview

roomwatch runs automatically every day at 9am to check a building's room vacancy webpage, uses Claude to intelligently summarize the availability status, and alerts you via push notification when rooms become available. Designed to run on free-tier cloud platforms for zero-cost automation.

## Features

- 🔍 **Web Crawling**: Automatically fetches and monitors room vacancy pages
- 🤖 **AI Summarization**: Uses Claude API to intelligently parse and summarize vacancy information
- 📱 **Push Notifications**: Sends instant alerts to your phone when rooms become available
- ⏰ **Scheduled Execution**: Runs automatically at 9am daily
- 💰 **Free Tier Optimized**: Designed for zero-cost cloud deployment
- 📊 **Change Detection**: Only notifies when actual changes occur

## Prerequisites

- Python 3.8 or higher
- Claude API key from [Anthropic](https://console.anthropic.com/)
- Pushover account and API token from [pushover.net](https://pushover.net/)
- Target webpage URL for room vacancies
- AWS account (free tier)

## Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/roomwatch.git
cd roomwatch
```

2. Install dependencies:
```bash
pip install -r requirements.txt
```

3. Configure your environment:
```bash
cp .env.example .env
```

4. Edit `.env` with your credentials:
```env
CLAUDE_API_KEY=your_claude_api_key_here
PUSHOVER_TOKEN=your_pushover_app_token
PUSHOVER_USER=your_pushover_user_key
TARGET_URL=https://example.com/room-vacancies
CHECK_INTERVAL=300  # seconds between checks (default: 5 minutes)
```

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `CLAUDE_API_KEY` | Your Anthropic API key | Yes |
| `PUSHOVER_TOKEN` | Your Pushover application API token | Yes |
| `PUSHOVER_USER` | Your Pushover user key | Yes |
| `TARGET_URL` | URL of the room vacancy page to monitor | Yes |
| `CHECK_INTERVAL` | Seconds between checks (default: 300) | No |
| `SCHEDULE_TIME` | Time to run daily (default: 09:00) | No |
| `LOG_LEVEL` | Logging verbosity (DEBUG/INFO/WARNING/ERROR) | No |

### Pushover Setup

1. Sign up at [pushover.net](https://pushover.net/)
2. Note your **User Key** from the dashboard
3. Create a new application:
   - Go to "Create an Application/API Token"
   - Name it "roomwatch" (or any name you prefer)
   - Note the **API Token/Key**
4. Use these credentials as `PUSHOVER_USER` and `PUSHOVER_TOKEN`

## Usage

### Cloud Deployment (Recommended for Free Tier)

This project is optimized to run once daily at 9am, making it perfect for free-tier serverless platforms.

#### AWS Lambda + EventBridge (Recommended)

AWS Lambda free tier includes:
- **1 million requests per month** (you'll use ~30/month)
- **400,000 GB-seconds of compute time** (way more than needed)
- **Always free** (doesn't expire after 12 months)

**Setup:**

1. Install AWS CLI and configure credentials locally for this project:
```bash
# Install AWS CLI if not already installed
# macOS: brew install awscli
# Linux: pip install awscli
# Windows: Download from AWS website

# Configure AWS credentials locally in the repository
mkdir -p .aws
export AWS_CONFIG_FILE=.aws/config
export AWS_SHARED_CREDENTIALS_FILE=.aws/credentials

# Run configure with local paths
aws configure
# Enter your AWS Access Key ID
# Enter your AWS Secret Access Key
# Enter your default region (e.g., us-east-1)
# Enter default output format (json)
```

**Important**: Add `.aws/` to your `.gitignore` to prevent committing credentials:
```bash
echo ".aws/" >> .gitignore
```

Alternatively, you can manually create the credentials files:
```bash
# Create .aws/credentials
cat > .aws/credentials << EOF
[default]
aws_access_key_id = YOUR_ACCESS_KEY_ID
aws_secret_access_key = YOUR_SECRET_ACCESS_KEY
EOF

# Create .aws/config
cat > .aws/config << EOF
[default]
region = us-east-1
output = json
EOF
```

For all subsequent AWS CLI commands in this project, set the environment variables:
```bash
export AWS_CONFIG_FILE=.aws/config
export AWS_SHARED_CREDENTIALS_FILE=.aws/credentials
```

Or create a helper script `.aws/env.sh`:
```bash
#!/bin/bash
export AWS_CONFIG_FILE="$(pwd)/.aws/config"
export AWS_SHARED_CREDENTIALS_FILE="$(pwd)/.aws/credentials"
```

Then source it before running AWS commands:
```bash
source .aws/env.sh
```

2. Create an IAM role for Lambda (one-time setup):
```bash
aws iam create-role --role-name roomwatch-lambda-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "lambda.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

aws iam attach-role-policy --role-name roomwatch-lambda-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
```

3. Package and deploy your function:
```bash
# Make sure AWS environment variables are set
source .aws/env.sh  # if using the helper script

# Create deployment package
zip -r roomwatch.zip roomwatch.py requirements.txt

# Deploy to Lambda
aws lambda create-function \
  --function-name roomwatch \
  --runtime python3.11 \
  --role arn:aws:iam::YOUR_ACCOUNT_ID:role/roomwatch-lambda-role \
  --handler roomwatch.lambda_handler \
  --zip-file fileb://roomwatch.zip \
  --timeout 30 \
  --environment Variables="{
    CLAUDE_API_KEY=your_key,
    PUSHOVER_TOKEN=your_token,
    PUSHOVER_USER=your_user,
    TARGET_URL=your_url
  }"
```

4. Create EventBridge rule to run daily at 9am:
```bash
# Make sure AWS environment variables are set
source .aws/env.sh  # if using the helper script
# Create the rule
aws events put-rule \
  --name roomwatch-daily \
  --schedule-expression "cron(0 9 * * ? *)" \
  --state ENABLED

# Add Lambda as target
aws events put-targets \
  --rule roomwatch-daily \
  --targets "Id"="1","Arn"="arn:aws:lambda:REGION:ACCOUNT_ID:function:roomwatch"

# Grant EventBridge permission to invoke Lambda
aws lambda add-permission \
  --function-name roomwatch \
  --statement-id roomwatch-eventbridge \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn arn:aws:events:REGION:ACCOUNT_ID:rule/roomwatch-daily
```

**To update the function:**
```bash
source .aws/env.sh  # if using the helper script
zip -r roomwatch.zip roomwatch.py requirements.txt
aws lambda update-function-code \
  --function-name roomwatch \
  --zip-file fileb://roomwatch.zip
```

**To view logs:**
```bash
source .aws/env.sh  # if using the helper script
aws logs tail /aws/lambda/roomwatch --follow
```

### Running Locally (Development/Testing)

```bash
python roomwatch.py
```

## How It Works

1. **Scheduled Trigger**: Cloud platform triggers execution at 9am daily
2. **Crawl**: Fetches the target webpage containing room vacancy information
3. **Parse**: Extracts relevant content (room numbers, availability status, prices)
4. **Summarize**: Sends the extracted data to Claude API for intelligent summarization
5. **Compare**: Checks if the vacancy status has changed since the last check
6. **Notify**: Sends a push notification to your phone if new rooms are available
7. **Store State**: Saves current state for next day's comparison

## Example Output

When a room becomes available, you'll receive a notification like:

```
🏠 New Room Available!

Building: Sunset Apartments
Room: 304
Status: Available
Price: $1,200/month
Move-in: Immediate

Summary: Studio apartment on 3rd floor
became available. Previously occupied.
```

## Troubleshooting

**AWS Lambda issues:**
- Check CloudWatch Logs: `aws logs tail /aws/lambda/roomwatch --follow`
- Verify IAM role has correct permissions
- Ensure EventBridge rule is enabled: `aws events list-rules`
- Check environment variables are set correctly
- Verify the function timeout is sufficient (default: 30s)

**GitHub Actions not running:**
- Check the Actions tab in your repository for error logs
- Verify all secrets are properly set
- Ensure the workflow file is in `.github/workflows/` directory

**No notifications received:**
- Verify your Pushover credentials (user key and app token)
- Test Pushover independently by sending a test notification from their website
- Check the execution logs for errors

**Crawler not detecting changes:**
- Ensure `TARGET_URL` is accessible from the cloud platform
- Check if the webpage structure has changed
- Review execution logs

## Privacy & Ethics

- This tool is for **personal use only**
- Designed to run once daily to minimize server load
- Respect the target website's `robots.txt` and terms of service
- Do not use this to scrape private or protected information
- Be mindful of cloud platform usage and stay within free tiers

## Acknowledgments

- [Anthropic Claude](https://www.anthropic.com/) for AI summarization
- [Pushover](https://pushover.net/) for push notifications
- Open source web scraping libraries

---

**Note**: Remember to keep your API keys secure and never commit them to version control. Always use environment variables or secure secret management.
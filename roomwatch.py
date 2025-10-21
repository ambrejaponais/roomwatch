#!/usr/bin/env python3
"""
roomwatch - Room vacancy monitoring with Claude AI and push notifications
"""

import os
import sys
import json
import logging
from datetime import datetime
from typing import Dict, Optional, Any
import requests
from bs4 import BeautifulSoup
from anthropic import Anthropic
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Configure logging
LOG_LEVEL = os.getenv('LOG_LEVEL', 'INFO')
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL),
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


class RoomWatch:
    """Main class for monitoring room vacancies"""

    def __init__(self):
        """Initialize RoomWatch with configuration from environment"""
        self.claude_api_key = os.getenv('CLAUDE_API_KEY')
        self.pushover_token = os.getenv('PUSHOVER_TOKEN')
        self.pushover_user = os.getenv('PUSHOVER_USER')
        self.target_url = os.getenv('TARGET_URL')
        self.state_file = os.getenv('STATE_FILE', 'state.json')

        # Validate required configuration
        self._validate_config()

        # Initialize Claude client
        self.claude_client = Anthropic(api_key=self.claude_api_key)

    def _validate_config(self):
        """Validate that all required configuration is present"""
        required_vars = {
            'CLAUDE_API_KEY': self.claude_api_key,
            'PUSHOVER_TOKEN': self.pushover_token,
            'PUSHOVER_USER': self.pushover_user,
            'TARGET_URL': self.target_url
        }

        missing = [var for var, value in required_vars.items() if not value]
        if missing:
            raise ValueError(f"Missing required environment variables: {', '.join(missing)}")

    def fetch_webpage(self) -> str:
        """
        Fetch the target webpage content

        Returns:
            str: The HTML content of the webpage
        """
        logger.info(f"Fetching webpage: {self.target_url}")
        try:
            headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
            response = requests.get(self.target_url, headers=headers, timeout=30)
            response.raise_for_status()
            logger.info("Webpage fetched successfully")
            return response.text
        except requests.RequestException as e:
            logger.error(f"Failed to fetch webpage: {e}")
            raise

    def extract_content(self, html: str) -> str:
        """
        Extract relevant text content from HTML

        Args:
            html: Raw HTML content

        Returns:
            str: Cleaned text content
        """
        logger.info("Extracting content from HTML")
        soup = BeautifulSoup(html, 'lxml')

        # Remove script and style elements
        for script in soup(['script', 'style', 'nav', 'footer', 'header']):
            script.decompose()

        # Get text content
        text = soup.get_text(separator='\n', strip=True)

        # Clean up whitespace
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        content = '\n'.join(lines)

        logger.info(f"Extracted {len(content)} characters of content")
        return content

    def summarize_with_claude(self, content: str) -> Dict[str, Any]:
        """
        Use Claude to analyze and summarize vacancy information

        Args:
            content: The extracted webpage content

        Returns:
            Dict containing summary and structured vacancy data
        """
        logger.info("Analyzing content with Claude AI")

        prompt = f"""以下のWebサイトコンテンツを分析して、ロイヤルパークス西新井の空室情報を簡潔な平文でまとめて。
空室がない場合のフォーマットは以下:
空室状況: なし

空室情報は階数、間取り、家賃を列挙する形にして。
空室がある場合のフォーマットは以下:
空室状況: あり
空室情報:
1. 階数 間取り 家賃
2. 階数 間取り 家賃


Webサイトコンテンツ:
{content[:4000]}
"""

        try:
            message = self.claude_client.messages.create(
                model="claude-sonnet-4-5-20250929",
                max_tokens=1024,
                messages=[
                    {"role": "user", "content": prompt}
                ]
            )

            # Extract the Japanese summary text
            summary = message.content[0].text.strip()

            logger.info(f"Claude analysis complete")
            return summary

        except Exception as e:
            logger.error(f"Failed to analyze with Claude: {e}")
            raise

    def load_previous_state(self) -> Optional[Dict]:
        """Load the previous state from disk"""
        try:
            if os.path.exists(self.state_file):
                with open(self.state_file, 'r') as f:
                    state = json.load(f)
                    logger.info("Previous state loaded")
                    return state
        except Exception as e:
            logger.warning(f"Could not load previous state: {e}")
        return None

    def save_state(self, state: Dict):
        """Save current state to disk"""
        try:
            state['last_check'] = datetime.now().isoformat()
            with open(self.state_file, 'w') as f:
                json.dump(state, f, indent=2)
            logger.info("State saved successfully")
        except Exception as e:
            logger.error(f"Failed to save state: {e}")

    def has_changes(self, current: Dict, previous: Optional[Dict]) -> bool:
        """
        Determine if there are significant changes

        Args:
            current: Current vacancy data
            previous: Previous vacancy data

        Returns:
            bool: True if there are changes worth notifying about
        """
        if previous is None:
            logger.info("No previous state - treating as change")
            return True

        # Check if vacancy status changed
        if current.get('has_vacancies') != previous.get('has_vacancies'):
            logger.info("Vacancy status changed")
            return True

        # Check if vacancy count changed
        if current.get('vacancy_count') != previous.get('vacancy_count'):
            logger.info("Vacancy count changed")
            return True

        # Check if specific rooms changed
        current_rooms = set(r.get('room', '') for r in current.get('rooms', []))
        previous_rooms = set(r.get('room', '') for r in previous.get('rooms', []))
        if current_rooms != previous_rooms:
            logger.info("Room list changed")
            return True

        logger.info("No significant changes detected")
        return False

    def send_notification(self, summary: str):
        """
        Send push notification via Pushover

        Args:
            summary: The Japanese summary text from Claude
        """
        logger.info("Sending push notification")

        # Send via Pushover
        try:
            response = requests.post(
                'https://api.pushover.net/1/messages.json',
                data={
                    'token': self.pushover_token,
                    'user': self.pushover_user,
                    'title': '部屋の空室情報',
                    'message': summary,
                    'url': self.target_url,
                    'url_title': '詳細を見る'
                },
                timeout=10
            )
            response.raise_for_status()
            logger.info("Notification sent successfully")
        except requests.RequestException as e:
            logger.error(f"Failed to send notification: {e}")
            raise

    def run(self) -> str:
        """
        Main execution method

        Returns:
            str: The Japanese summary
        """
        logger.info("Starting RoomWatch check")

        try:
            # Fetch and parse webpage
            html = self.fetch_webpage()
            content = self.extract_content(html)

            # Analyze with Claude
            summary = self.summarize_with_claude(content)

            # Send notification
            self.send_notification(summary)

            logger.info("RoomWatch check completed successfully")
            return summary

        except Exception as e:
            logger.error(f"RoomWatch check failed: {e}")
            raise


def lambda_handler(event, context):
    """
    AWS Lambda handler function

    Args:
        event: Lambda event data
        context: Lambda context

    Returns:
        Dict: Response with status code and body
    """
    try:
        watcher = RoomWatch()
        result = watcher.run()

        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': 'RoomWatch executed successfully',
                'result': result
            })
        }
    except Exception as e:
        logger.error(f"Lambda execution failed: {e}")
        return {
            'statusCode': 500,
            'body': json.dumps({
                'message': 'RoomWatch execution failed',
                'error': str(e)
            })
        }


def main():
    """Main entry point for local execution"""
    try:
        watcher = RoomWatch()
        summary = watcher.run()

        print("\n" + "="*50)
        print("空室情報")
        print("="*50)
        print(summary)
        print("="*50 + "\n")

        return 0
    except Exception as e:
        logger.error(f"Execution failed: {e}")
        return 1


if __name__ == '__main__':
    sys.exit(main())

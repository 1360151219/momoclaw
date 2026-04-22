#!/bin/bash

# Install a skill to the project's .claude/skills directory
# Usage: ./install-skill.sh <owner/repo@skill-name>
# Example: ./install-skill.sh vercel-labs/agent-skills@vercel-react-best-practices

set -e

if [[ -z "$1" ]]; then
  echo "Usage: $0 <owner/repo@skill-name>"
  echo "Example: $0 vercel-labs/agent-skills@vercel-react-best-practices"
  exit 1
fi

FULL_SKILL_NAME="$1"

# Extract skill name (the part after @)
SKILL_NAME="${FULL_SKILL_NAME##*@}"

if [[ -z "$SKILL_NAME" || "$SKILL_NAME" == "$FULL_SKILL_NAME" ]]; then
  echo "Error: Invalid skill format. Expected: owner/repo@skill-name"
  exit 1
fi

# Find .claude directory by walking up from script location
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

SKILL_TARGET="$CLAUDE_DIR/skills/$SKILL_NAME"

# Step 1: Create temp directory for skill installation
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# Step 2: Download skill from GitHub (owner/repo@skill-name -> skills/skill-name)
REPO_PATH="${FULL_SKILL_NAME%%@*}"
SKILL_PATH="skills/$SKILL_NAME"

# Convert to raw GitHub URL
GITHUB_URL="https://github.com/$REPO_PATH/raw/main/$SKILL_PATH"

echo "Installing skill '$SKILL_NAME' from $REPO_PATH..."

# Step 3: Clone or download the skill files
if command -v git &> /dev/null; then
  # Use git sparse checkout for efficient download
  git clone --depth 1 --filter=blob:none --sparse "https://github.com/$REPO_PATH.git" "$TEMP_DIR/repo" 2>/dev/null || {
    echo "Error: Failed to clone repository"
    exit 1
  }
  cd "$TEMP_DIR/repo"
  git sparse-checkout set "$SKILL_PATH" 2>/dev/null || true

  if [[ -d "$TEMP_DIR/repo/$SKILL_PATH" ]]; then
    mkdir -p "$SKILL_TARGET"
    cp -r "$TEMP_DIR/repo/$SKILL_PATH/"* "$SKILL_TARGET/" 2>/dev/null || true
  fi
else
  # Fallback: use curl to download individual files
  mkdir -p "$SKILL_TARGET"
  # Try to download SKILL.md
  curl -fsSL "$GITHUB_URL/SKILL.md" -o "$SKILL_TARGET/SKILL.md" 2>/dev/null || true
  # Try to download scripts if exists
  mkdir -p "$SKILL_TARGET/scripts"
  curl -fsSL "$GITHUB_URL/scripts/index.ts" -o "$SKILL_TARGET/scripts/index.ts" 2>/dev/null || true
fi

# Step 4: Verify installation
if [[ ! -f "$SKILL_TARGET/SKILL.md" ]]; then
  echo "Error: Skill '$SKILL_NAME' installation failed (SKILL.md not found)"
  exit 1
fi

echo "Skill '$SKILL_NAME' installed successfully to .claude/skills/"

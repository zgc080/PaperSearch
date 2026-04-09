FROM node:20-slim

# Install Python3 + pip for PDF/DOCX export scripts
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip python3-venv curl && \
    rm -rf /var/lib/apt/lists/*

# Create a virtual environment for Python packages
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Install Python dependencies
RUN pip install --no-cache-dir reportlab python-docx

# Pre-download CJK font for PDF export
RUN mkdir -p /tmp/fonts && \
    curl -sL -o /tmp/fonts/NotoSansTC.ttf \
    "https://github.com/google/fonts/raw/main/ofl/notosanstc/NotoSansTC%5Bwght%5D.ttf" || true

WORKDIR /app

# Copy package files and install Node dependencies
COPY package.json package-lock.json* ./
RUN npm install --production=false

# Copy all source files
COPY . .

# Build the project
RUN npm run build

# Expose port 7860 (Hugging Face Spaces default)
ENV PORT=7860
EXPOSE 7860

# Start the production server
CMD ["node", "dist/index.cjs"]

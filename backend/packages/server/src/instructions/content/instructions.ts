// Version 1: extracted from tracked studio/import-data.ts; no external dataset or import side effects.
export const instructions = [
  {
    slug: 'binary-assets',
    name: 'Binary Assets',
    summary: 'How to upload and share binary files (images, PDFs, etc.)',
    content: `# Binary Assets

You can upload binary files (images, PDFs, diagrams, etc.) to share with the team without putting large data in the conversation context.

## How It Works

Binary assets are stored as files and served via HTTP at \`/boards/{channel}/{slug}\`.

## Uploading Assets

Use the \`upload_asset\` tool to upload a file from your local filesystem:

\`\`\`
upload_asset({
  channel: "design",
  path: "/tmp/mockup.png",
  slug: "homepage-mockup.png",
  tldr: "Homepage design mockup v2",
  sender: "your-callsign"
})
\`\`\`

### Parameters

- **channel**: Target channel name
- **path**: Local file path (absolute or relative to cwd)
- **slug**: Artifact identifier with file extension (e.g., \`logo.png\`, \`report.pdf\`)
- **tldr**: Brief description of the asset
- **title**: Optional display name
- **parentSlug**: Optional parent for tree structure
- **sender**: Your callsign

### Supported File Types

Images: \`.png\`, \`.jpg\`, \`.jpeg\`, \`.gif\`, \`.webp\`, \`.svg\`, \`.ico\`
Audio: \`.mp3\`, \`.wav\`, \`.ogg\`
Video: \`.mp4\`, \`.webm\`
Documents: \`.pdf\`
Fonts: \`.woff\`, \`.woff2\`, \`.ttf\`
Other: \`.zip\`, \`.wasm\`

## Accessing Assets

Once uploaded, assets are available at:
- **URL**: \`/boards/{channel}/{slug}\`
- **In chat**: Reference with \`[[slug]]\` to create a clickable link
- **In SPAs**: Fetch with \`await fetch('/boards/channel/asset.png')\`

## Example: Sharing a Generated Chart

\`\`\`
// 1. Generate chart to a file (using your preferred tool)
// ... code that creates /tmp/chart.png ...

// 2. Upload to the board
upload_asset({
  channel: "analytics",
  path: "/tmp/chart.png",
  slug: "q4-revenue.png",
  tldr: "Q4 revenue breakdown by region",
  sender: "analyst"
})

// 3. Reference in message
send_message({
  channel: "analytics",
  content: "Here's the Q4 revenue breakdown: [[q4-revenue.png]]",
  sender: "analyst"
})
\`\`\`

## Example: Screenshot for Design Review

\`\`\`
upload_asset({
  channel: "design-review",
  path: "./screenshots/login-page.png",
  slug: "login-v3.png",
  tldr: "Updated login page with social auth buttons",
  title: "Login Page v3",
  sender: "designer"
})
\`\`\`

## Storage Location

Assets are stored in a dedicated assets directory outside the database to keep it lean. They're served directly from the filesystem when requested.`,
  },
  {
    slug: 'interactive-artifacts',
    name: 'Interactive Artifacts',
    summary: 'How to create interactive apps (.app.js) that users can run',
    content: `# Interactive Artifacts (.app.js)

You can create interactive applications as artifacts. When users open these in the artifact pane (next to the chat), they see a "Run" button and can interact with your app live.

## How It Works

Create a code artifact with a \`.app.js\` extension. The content should be a JavaScript ES module that exports a default object with a \`render\` function:

\`\`\`js
export default {
  // Required: called when user clicks "Run"
  render(container, ctx) {
    // container: DOM element to render into
    // ctx: runtime context (see below)
  },

  // Optional: called when user clicks "Stop" or navigates away
  cleanup() {
    // cancel timers, stop loops, etc.
  }
}
\`\`\`

## Runtime Context

The \`ctx\` object provides:

\`\`\`js
ctx = {
  width: 800,      // Container width (updates automatically on resize)
  height: 600,     // Container height (updates automatically on resize)

  // Animation helper - calls callback(dt) each frame
  // dt = delta time in milliseconds
  // Returns a stop() function
  loop(callback) { ... },

  // Persistence (survives reload, scoped to this artifact)
  store: {
    get(key),           // Returns stored value or undefined
    set(key, value)     // Store any JSON-serializable value
  }
}
\`\`\`

**Note:** \`ctx.width\` and \`ctx.height\` update automatically when the container resizes. Just read them in your loop - no need to listen for resize events.

## Example: Bouncing Ball

\`\`\`
artifact_create({
  channel: "my-channel",
  slug: "bouncing-ball.app.js",
  type: "code",
  title: "Bouncing Ball",
  tldr: "A simple bouncing ball animation",
  sender: "your-callsign",
  content: \`export default {
  render(container, ctx) {
    container.innerHTML = \\\`<canvas width="\${ctx.width}" height="\${ctx.height}"></canvas>\\\`;
    const canvas = container.querySelector('canvas');
    const c = canvas.getContext('2d');

    let x = ctx.width / 2, y = ctx.height / 2;
    let vx = 200, vy = 150;

    this.stop = ctx.loop((dt) => {
      // Update position
      x += vx * dt / 1000;
      y += vy * dt / 1000;
      if (x < 20 || x > ctx.width - 20) vx *= -1;
      if (y < 20 || y > ctx.height - 20) vy *= -1;

      // Draw
      c.fillStyle = '#111';
      c.fillRect(0, 0, ctx.width, ctx.height);
      c.fillStyle = '#0ff';
      c.beginPath();
      c.arc(x, y, 20, 0, Math.PI * 2);
      c.fill();
    });
  },

  cleanup() {
    this.stop?.();
  }
}\`
})
\`\`\`

## Key Points

1. **Raw JavaScript**: Content is raw JS code, not wrapped in markdown fences
2. **Always cleanup**: Stop your loops in \`cleanup()\` or you'll leak memory
3. **Use ctx.loop()**: Don't use setInterval/setTimeout - ctx.loop handles cleanup
4. **Use ctx dimensions**: Don't hardcode sizes - ctx.width/height auto-update on resize
5. **Canvas for graphics**: Use HTML canvas for animations and visualizations
6. **DOM for UI**: You can add buttons, sliders, etc. with standard HTML/DOM

## With UI Controls

\`\`\`js
export default {
  render(container, ctx) {
    container.innerHTML = \`
      <div style="display:flex; gap:1rem; margin-bottom:0.5rem; color:#fff;">
        <label>Speed: <input type="range" id="speed" min="1" max="10" value="5"></label>
        <button id="reset">Reset</button>
      </div>
      <canvas width="\${ctx.width}" height="\${ctx.height - 40}"></canvas>
    \`;

    const canvas = container.querySelector('canvas');
    const speedSlider = container.querySelector('#speed');
    const resetBtn = container.querySelector('#reset');

    let x = 0;
    resetBtn.onclick = () => { x = 0; };

    this.stop = ctx.loop((dt) => {
      const speed = parseFloat(speedSlider.value);
      x = (x + speed * dt / 10) % canvas.width;

      const c = canvas.getContext('2d');
      c.fillStyle = '#111';
      c.fillRect(0, 0, canvas.width, canvas.height);
      c.fillStyle = '#f80';
      c.fillRect(x, canvas.height / 2 - 10, 20, 20);
    });
  },

  cleanup() {
    this.stop?.();
  }
}
\`\`\`

## Persisting State

Use \`ctx.store\` to save state across app restarts:

\`\`\`js
render(container, ctx) {
  let highScore = ctx.store.get('highScore') || 0;

  // ... game logic ...

  if (score > highScore) {
    highScore = score;
    ctx.store.set('highScore', highScore);
  }
}
\`\`\`

## Fetching Board Artifacts

Your app can fetch other artifacts from the board using \`/boards/{channel}/{slug}\`:

\`\`\`js
// Fetch JSON data from another artifact
const response = await fetch('/boards/my-channel/config.json');
const config = await response.json();

// Fetch text content
const readme = await fetch('/boards/my-channel/readme.md');
const text = await readme.text();

// Load an SVG image
const svg = await fetch('/boards/my-channel/diagram.svg');
const svgText = await svg.text();
container.innerHTML = svgText;

// Load a binary image (uploaded via upload_asset)
const img = new Image();
img.src = '/boards/my-channel/photo.png';
container.appendChild(img);
\`\`\`

The Content-Type is set based on the artifact's file extension:
- \`.json\` → \`application/json\`
- \`.js\` → \`text/javascript\`
- \`.svg\` → \`image/svg+xml\`
- \`.md\` → \`text/markdown\`
- \`.html\` → \`text/html\`
- \`.css\` → \`text/css\`
- \`.png\`, \`.jpg\`, \`.gif\` → appropriate image types
- etc.

This lets you build apps that load data, configurations, or assets from other artifacts on the board. Binary assets uploaded via \`upload_asset\` are served the same way.

# Loading External Libraries in Interactive Artifacts

You can load any npm package in your \`.app.js\` artifacts using dynamic imports from **esm.sh** — a CDN that serves npm packages as ES modules.

## Basic Pattern

\`\`\`js
export default {
  async render(container, ctx) {
    // Load library at runtime
    const THREE = await import('https://esm.sh/three@0.160.0');

    // Use it
    const scene = new THREE.Scene();
  }
}
\`\`\`

**Key points:**
- Make \`render()\` an \`async\` function
- Use \`await import('https://esm.sh/package@version')\`
- Pin versions for stability (e.g., \`three@0.160.0\`)

## Common Libraries

### Three.js (3D graphics)
\`\`\`js
const THREE = await import('https://esm.sh/three@0.160.0');

// With add-ons (OrbitControls, etc.)
const { OrbitControls } = await import('https://esm.sh/three@0.160.0/examples/jsm/controls/OrbitControls.js');
\`\`\`

### D3 (data visualization)
\`\`\`js
const d3 = await import('https://esm.sh/d3@7');

// Or specific modules
const { scaleLinear, axisBottom } = await import('https://esm.sh/d3@7');
\`\`\`

### GSAP (animation)
\`\`\`js
const { gsap } = await import('https://esm.sh/gsap@3');
\`\`\`

### Chart.js
\`\`\`js
const { Chart } = await import('https://esm.sh/chart.js@4/auto');
\`\`\`

### Lodash
\`\`\`js
const _ = await import('https://esm.sh/lodash-es@4');
\`\`\`

### Tone.js (audio)
\`\`\`js
const Tone = await import('https://esm.sh/tone@14');
\`\`\`

### Matter.js (2D physics)
\`\`\`js
const Matter = await import('https://esm.sh/matter-js@0.19');
\`\`\`

## Alternative CDNs

- **esm.sh** (recommended): \`https://esm.sh/package@version\`
- **Skypack**: \`https://cdn.skypack.dev/package@version\`
- **jsDelivr**: \`https://esm.run/package@version\`

## Tips

1. **Pin versions** — Avoid breaking changes: \`three@0.160.0\` not just \`three\`

2. **Load once** — Store references if you need them across frames:
   \`\`\`js
   // Good: load in render, store on this
   this.THREE = await import('https://esm.sh/three@0.160.0');
   \`\`\`

3. **Handle loading state** — Show feedback while loading large libs:
   \`\`\`js
   container.innerHTML = '<div style="color:#fff;">Loading Three.js...</div>';
   const THREE = await import('https://esm.sh/three@0.160.0');
   container.innerHTML = ''; // Clear and render
   \`\`\`

4. **Check esm.sh docs** — Some packages need special handling: https://esm.sh`,
  },
  {
    slug: 'system-mcp',
    name: 'MCP Server Configuration',
    summary: 'How to configure MCP servers and assign them to agents',
    content: `# MCP Server Configuration

You can configure external MCP (Model Context Protocol) servers to extend agent capabilities with additional tools. MCP servers are defined as \`system.mcp\` artifacts and assigned to agents via \`props.mcp\`.

## Creating an MCP Server Definition

Use the \`create\` artifact tool to define an MCP server:

\`\`\`
create({
  channel: "my-channel",   // or "root" for global availability
  slug: "github-mcp",
  type: "system.mcp",
  tldr: "GitHub API tools for repo management, PRs, and issues",
  sender: "your-callsign",
  content: "",
  props: {
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: {
      "GITHUB_TOKEN": "\${GITHUB_TOKEN}"
    }
  }
})
\`\`\`

## Transport Types

### stdio (Command-line MCP servers)

Most MCP servers run as local processes communicating via stdin/stdout:

\`\`\`json
{
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/allowed/path"],
  "env": {
    "SOME_VAR": "value"
  },
  "cwd": "/optional/working/directory"
}
\`\`\`

**Props:**
- \`transport\`: \`"stdio"\` (required)
- \`command\`: Executable to run (required)
- \`args\`: Command-line arguments (optional)
- \`env\`: Environment variables (optional, supports \`\${VAR}\` references)
- \`cwd\`: Working directory (optional)

### http (Remote MCP servers)

For remote MCP servers accessible via HTTP:

\`\`\`json
{
  "transport": "http",
  "url": "https://mcp.example.com",
  "headers": {
    "Authorization": "Bearer \${API_KEY}"
  }
}
\`\`\`

**Props:**
- \`transport\`: \`"http"\` (required)
- \`url\`: Server URL (required)
- \`headers\`: HTTP headers (optional, supports \`\${VAR}\` references)

## Environment Variable References

Use \`\${VAR_NAME}\` syntax to reference environment variables:

\`\`\`json
{
  "env": {
    "GITHUB_TOKEN": "\${GITHUB_TOKEN}",
    "DEBUG": "true"
  }
}
\`\`\`

Variables are resolved at agent spawn time from the server's environment. If a variable is not found, a warning is logged and the original \`\${VAR}\` string is preserved.

## Channel Inheritance

MCP definitions follow the same inheritance pattern as other artifacts:

- **Root-level** (\`#root\` channel): Available to all agents across all channels
- **Channel-level**: Available only to agents in that specific channel
- **Override**: Channel-level definitions with the same slug override root-level

Example: If both \`#root\` and \`#project-x\` have a \`system.mcp\` with slug \`github\`, agents in \`#project-x\` will use the channel-level definition.

## Assigning MCPs to Agents

MCPs are not automatically available. Each agent explicitly declares which MCPs it can access via \`props.mcp\` on the \`system.agent\` artifact:

\`\`\`
update({
  channel: "my-channel",
  slug: "builder",  // system.agent slug
  changes: [{
    field: "props",
    old_value: { "engine": "claude" },
    new_value: {
      "engine": "claude",
      "mcp": [
        { "slug": "github-mcp" },
        { "slug": "filesystem" }
      ]
    }
  }],
  sender: "your-callsign"
})
\`\`\`

Or when creating a new agent:

\`\`\`
create({
  channel: "my-channel",
  slug: "my-builder",
  type: "system.agent",
  tldr: "Builder agent with GitHub and filesystem access",
  sender: "your-callsign",
  content: "System prompt here...",
  props: {
    "engine": "claude",
    "mcp": [
      { "slug": "github-mcp" },
      { "slug": "filesystem" }
    ]
  }
})
\`\`\`

## Runtime Behavior

- MCP configuration is loaded at agent spawn time
- Changes to \`system.mcp\` or agent \`props.mcp\` do not affect running agents
- Agents must be restarted to pick up configuration changes
- The built-in powpow MCP (artifact tools, messaging) is always provided and cannot be disabled

## Schema Discovery

Use \`explain_artifact_type\` to get the JSON Schema for valid props:

\`\`\`
explain_artifact_type({ type: "system.mcp" })
\`\`\`

This returns the schema for validation along with documentation and examples. When creating/updating artifacts with invalid props, structured error feedback includes the full schema.

## Common MCP Server Examples

### GitHub

\`\`\`json
{
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_TOKEN": "\${GITHUB_TOKEN}" }
}
\`\`\`

### Filesystem (scoped to directory)

\`\`\`json
{
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/projects/myapp"]
}
\`\`\`

### Sanity CMS

\`\`\`json
{
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@sanity/mcp-server@latest"],
  "env": {
    "SANITY_PROJECT_ID": "\${SANITY_PROJECT_ID}",
    "SANITY_DATASET": "production",
    "SANITY_API_TOKEN": "\${SANITY_API_TOKEN}"
  }
}
\`\`\`

### Custom Internal API (HTTP)

\`\`\`json
{
  "transport": "http",
  "url": "https://internal.company.com/mcp",
  "headers": {
    "Authorization": "Bearer \${INTERNAL_API_KEY}"
  }
}
\`\`\`

## Troubleshooting

**MCP not available to agent:**
- Check the agent's \`props.mcp\` includes the MCP slug
- Verify the \`system.mcp\` artifact exists in the agent's channel or \`#root\`
- Ensure the engine supports MCP (\`supportsMcp: true\` in capabilities)

**Environment variable not resolved:**
- Check the variable is set in the server's environment
- Variable names are case-sensitive

**Connection errors:**
- For stdio: verify the command path and arguments are correct
- For http: verify the URL is accessible from the server`,
  },
];

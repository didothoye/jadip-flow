// Phase 4 : API REST, serveur MCP
import { registerRoutes } from './app.js';
import apiV1 from './routes/api-v1.js';
import mcpRoutes from './routes/mcp.js';

registerRoutes(apiV1, mcpRoutes);

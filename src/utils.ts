// src/utils.ts
export function layout(content: string, title: string = "Xano MCP Server"): string {
	return `
	  <!DOCTYPE html>
	  <html>
		<head>
		  <title>${title}</title>
		  <style>
			body { font-family: system-ui, sans-serif; line-height: 1.6; max-width: 800px; margin: 0 auto; padding: 20px; }
			pre { background: #f4f4f4; padding: 10px; border-radius: 4px; overflow-x: auto; }
			code { background: #f4f4f4; padding: 2px 4px; border-radius: 4px; }
		  </style>
		</head>
		<body>
		  ${content}
		</body>
	  </html>
	`;
  }
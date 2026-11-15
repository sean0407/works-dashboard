import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';

// Static build for GitHub Pages: no server, data is read in the browser with the visitor's Google token.
const root=fileURLToPath(new URL('.',import.meta.url));
export default defineConfig({
 root:'pages',
 base:process.env.PAGES_BASE??'/works-dashboard/',
 publicDir:'../public',
 plugins:[react()],
 resolve:{alias:{'@':root}},
 build:{outDir:'../dist-pages',emptyOutDir:true,rollupOptions:{input:{index:fileURLToPath(new URL('pages/index.html',import.meta.url)),privacy:fileURLToPath(new URL('pages/privacy.html',import.meta.url))}}},
 server:{port:5181,strictPort:true},
});

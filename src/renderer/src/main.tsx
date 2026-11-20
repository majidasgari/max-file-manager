import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'vazirmatn/Vazirmatn-Variable-font-face.css'
import App from './App'
import { PortalPicker } from './PortalPicker'
import { StandaloneEditor, StandaloneGallery } from './Standalone'
import { StandaloneMusic } from './StandaloneMusic'
import { StandaloneVideo } from './StandaloneVideo'
import './style.css'

const params = new URLSearchParams(window.location.search)
const portal = params.get('portal') === '1'
const viewerPath = params.get('path') ?? ''
const galleryWindow = params.get('gallery') === '1'
const editorWindow = params.get('editor') === '1'
const musicWindow = params.get('music') === '1'
const videoWindow = params.get('video') === '1'

const screen = portal ? (
  <PortalPicker />
) : galleryWindow ? (
  <StandaloneGallery path={viewerPath} />
) : editorWindow ? (
  <StandaloneEditor path={viewerPath} />
) : musicWindow ? (
  <StandaloneMusic path={viewerPath} />
) : videoWindow ? (
  <StandaloneVideo path={viewerPath} />
) : (
  <App />
)

createRoot(document.getElementById('root')!).render(<StrictMode>{screen}</StrictMode>)

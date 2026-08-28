import { BrowserRouter, Route, Routes } from 'react-router'
import EpisodePage from '@/routes/EpisodePage'
import HomePage from '@/routes/HomePage'
import WorkspaceSettingsPage from '@/routes/WorkspaceSettingsPage'

// 路由表：只有三个页面（#20）；feature 随里程碑逐期落
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/workspaces/:wsId/episodes/:episodeId" element={<EpisodePage />} />
        <Route path="/workspaces/:wsId/settings" element={<WorkspaceSettingsPage />} />
      </Routes>
    </BrowserRouter>
  )
}

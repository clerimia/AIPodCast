import { BrowserRouter, Route, Routes } from 'react-router'
import EpisodePage from '@/routes/EpisodePage'
import HomePage from '@/routes/HomePage'
import PrototypeAiElementsPage from '@/routes/PrototypeAiElementsPage'
import WorkspacePage from '@/routes/WorkspacePage'
import WorkspaceSettingsPage from '@/routes/WorkspaceSettingsPage'

// 路由表：#20 三页面 + 工作间页面（/workspaces/:wsId，#25 后应用户要求新增）
// /prototype/ai-elements-message 为 #33 POC 一次性路由，验证后整条移除
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/workspaces/:wsId" element={<WorkspacePage />} />
        <Route path="/workspaces/:wsId/episodes/:episodeId" element={<EpisodePage />} />
        <Route path="/workspaces/:wsId/settings" element={<WorkspaceSettingsPage />} />
        <Route path="/prototype/ai-elements-message" element={<PrototypeAiElementsPage />} />
      </Routes>
    </BrowserRouter>
  )
}

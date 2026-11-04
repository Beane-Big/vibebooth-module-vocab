import Nav from "./components/Nav";
import WordPopup from "./components/WordPopup";
import History from "./pages/History";
import Home from "./pages/Home";
import Review from "./pages/Review";
import SettingsPage from "./pages/SettingsPage";
import Study from "./pages/Study";
import TestPage from "./pages/TestPage";
import Wrongs from "./pages/Wrongs";

// 页面不多，用路径区分即可，不引入路由库：/apps/vocab/<页面>/。
const pages: Record<string, () => React.JSX.Element> = {
  study: Study,
  review: Review,
  test: TestPage,
  wrong: Wrongs,
  history: History,
  settings: SettingsPage,
};

// 背景色块、导航和页面都是 .app 的直接子元素：导航的液态玻璃（Nav 里的 useLiquidGlass）要求这样才能折射到它们。
export default function App() {
  const name = location.pathname.replace(/^\/apps\/vocab\/?/, "").split("/")[0];
  const Page = pages[name] ?? Home;
  return (
    <div className="app">
      <div className="backdrop" aria-hidden="true" />
      <Nav current={name} />
      <Page />
      <WordPopup />
    </div>
  );
}

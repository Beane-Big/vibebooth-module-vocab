import TabBar from "./components/TabBar";
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

export default function App() {
  const name = location.pathname.replace(/^\/apps\/vocab\/?/, "").split("/")[0];
  const Page = pages[name] ?? Home;
  return (
    <>
      <Page />
      <TabBar current={name} />
      <WordPopup />
    </>
  );
}

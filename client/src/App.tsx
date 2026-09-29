import { useEffect } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import FanController from "./pages/FanController";


function Router() {
  // file:// has a filesystem path, so /motor-ble-controller/ never matches;
  // keep hosted routing unchanged and only fall back to the app for local files.
  const Fallback = location.protocol === "file:" ? FanController : NotFound;
  return (
    <Switch>
      <Route path={"/motor-ble-controller/"} component={FanController} />
      <Route path={"/404"} component={NotFound} />
      {/* Final fallback route */}
      <Route component={Fallback} />
    </Switch>
  );
}

function App() {
    // Handle GitHub Pages 404 redirect for SPA routing
  useEffect(() => {
    const redirect = sessionStorage.redirect;
    delete sessionStorage.redirect;
    if (redirect && redirect !== location.href) {
      history.replaceState({}, '', redirect.replace(/~and~/g, '&'));
    }
  }, []);
  
  return (
    <ErrorBoundary>
      <ThemeProvider
        defaultTheme="light"
      >
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;

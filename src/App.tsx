import React from "react";
import UranoWidget from "./components/UranoWidget";
import "./styles/globals.css";

export default function App(): React.ReactElement {
  return (
    <div className="urano-page">
      <UranoWidget />
    </div>
  );
}

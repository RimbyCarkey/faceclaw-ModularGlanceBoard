import { launchWorkerAppWindow, type AppDefinition } from "../app-definition";

const pegBounce: AppDefinition = {
  appId: "peg-bounce",
  title: "Peg-bounce",
  icon: "peg-bounce",
  launch: ctx => launchWorkerAppWindow(ctx, {
    createWorker: () => new Worker("./peg-bounce.worker"),
    windowId: "peg-bounce:main",
    title: "Peg-bounce",
    iconLetter: "P",
    icon: "peg-bounce",
    acceptsDirectional: true,
    heightMode: "max",
  }),
};
export default pegBounce;

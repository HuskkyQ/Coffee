globalThis.fetch = async () => {
  throw new Error("测试期间发生了意外的网络请求");
};

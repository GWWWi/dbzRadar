/**
 * main.ts —— 应用入口
 *
 * 职责：
 *   1) 初始化 QuickEarth（QE）引擎：
 *      - 先设置 wasm / workers 资源路径（位于 public/libs/，必须在 init 之前设置）；
 *      - init(undefined, true) 进入“免费二维模式”（无需授权码，本地使用）。
 *   2) 引入 Leaflet 样式与全局样式；
 *   3) 创建并挂载 Vue 应用。
 */

import { createApp } from 'vue';
import { init as qeInit, consts } from '@quickearth/core';
import 'leaflet/dist/leaflet.css'; // Leaflet 基础样式（必须）
// Element Plus 样式（时间选择控件用）+ 深色主题变量（配合 html.dark）
import 'element-plus/dist/index.css';
import 'element-plus/theme-chalk/dark/css-vars.css';
import './styles.css';             // 平台自定义样式

import App from './App.vue';

// —— QuickEarth 初始化（全局仅需一次）——
// wasm / workers 由 QE 运行时按需加载，路径相对站点根目录
consts.wasmPath = '/libs/wasm';
consts.workerPath = '/libs/workers';
// 免费二维模式：token 传 undefined、freeVersion=true
qeInit(undefined, true);

// —— 挂载 Vue 应用 ——
createApp(App).mount('#app');

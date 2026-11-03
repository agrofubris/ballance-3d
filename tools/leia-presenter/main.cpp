// Ballance LeiaSR presenter helper (Win32 + DX12).
//
// Standalone process that receives composed full-SbS pairs from the Electron
// main process over a named pipe, uploads them to a GPU texture and displays
// them in an activatable, borderless fullscreen window on the chosen monitor.
// Without the SR runtime it presents the plain side-by-side frame; with it, the
// pair is copied into a full-SbS B8G8R8A8 compose texture and the SR-lib
// weaver writes into an app-owned panel-extent texture that is then blitted to
// the swap chain. The hardware-validated rules followed here (see
// Leia-SR-Implementation.md): BGRA weave input/output, never weave into a
// swap-chain buffer, settle one frame after a target change, fall back instead
// of blanking on a failed weave, and exit for a transport restart on device
// removal.
//
// Keyboard input from the focused presenter window is forwarded to Electron
// main on a third pipe; main injects it into the offscreen game page.
//
// Pipe contract (little-endian), matching electron/leia/transport.cjs:
//   frame message: magic u32 (0x4149454c), frameId u32, width u32, height u32,
//                  format u32 (1 = BGRA8 pixels, 2 = GPU shared texture),
//                  payloadBytes u32, payload
//     format 2 payload: sourcePid u32, pixelFormat u32 (1 bgra8, 2 rgba8),
//       flags u32 (1 = probe only), reserved u32, handle u64.
//   ack message:   magic u32 (0x4149454c), frameId u32
//   input message: magic u32 (0x59454b42 "BKEY"), kind u32 (1 = key, 2 = control),
//                  vkCode u32, scanCode u32, flags u32
//     flags: bit 0 key up, bit 1 repeat, bit 2 extended, bit 3 shift,
//            bit 4 control, bit 5 alt, bit 6 caps lock
//     control kind: vkCode = code (2 = shared texture failed), scanCode = frameId.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3d12.h>
#include <dxgi1_6.h>
#include <d3dcompiler.h>
#include <shellscalingapi.h>

#if defined(BALLANCE_LEIA_SR)
#include "SR.hpp"
#endif

#include <atomic>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <vector>

#pragma comment(lib, "d3d12.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "d3dcompiler.lib")
#pragma comment(lib, "user32.lib")

namespace {

constexpr uint32_t kFrameMagic = 0x4149454c;
constexpr size_t kFrameHeaderBytes = 24;
constexpr size_t kAckBytes = 8;
constexpr uint32_t kInputMagic = 0x59454b42;  // "BKEY"
constexpr size_t kInputMessageBytes = 20;
constexpr uint32_t kInputKindKey = 1;
constexpr uint32_t kInputKindControl = 2;
constexpr uint32_t kControlSharedTextureFailed = 2;
constexpr uint32_t kKeyFlagUp = 1u << 0;
constexpr uint32_t kKeyFlagRepeat = 1u << 1;
constexpr uint32_t kKeyFlagExtended = 1u << 2;
constexpr uint32_t kKeyFlagShift = 1u << 3;
constexpr uint32_t kKeyFlagControl = 1u << 4;
constexpr uint32_t kKeyFlagAlt = 1u << 5;
constexpr uint32_t kKeyFlagCapsLock = 1u << 6;
constexpr wchar_t kFramePipeName[] = L"\\\\.\\pipe\\ballance_leia_frames";
constexpr wchar_t kAckPipeName[] = L"\\\\.\\pipe\\ballance_leia_ack";
constexpr wchar_t kInputPipeName[] = L"\\\\.\\pipe\\ballance_leia_input";
constexpr UINT kSwapChainBufferCount = 2;
constexpr UINT kMaxFramesInFlight = 1;
// B8G8R8A8 is what the SR SDK's pipeline and samples use for the weaver input
// and output; an RGBA input can weave black on hardware. Electron's offscreen
// paint bitmap is already BGRA on Windows, so the transport frame (format 1)
// is uploaded as BGRA with no swizzle.
constexpr DXGI_FORMAT kSwapChainFormat = DXGI_FORMAT_B8G8R8A8_UNORM;
constexpr DXGI_FORMAT kFrameTextureFormat = DXGI_FORMAT_B8G8R8A8_UNORM;
constexpr uint32_t kFrameFormatBgra8 = 1;
constexpr uint32_t kFrameFormatSharedTexture = 2;
constexpr size_t kSharedTexturePayloadBytes = 24;
constexpr uint32_t kSharedPixelBgra8 = 1;
constexpr uint32_t kSharedPixelRgba8 = 2;
constexpr uint32_t kSharedProbe = 1;

bool MonitorRectForIndex(int index, RECT* rect);
bool MonitorDeviceForIndex(int index, wchar_t deviceName[32]);
void ActivatePresenterWindow(HWND hwnd);

void Log(const char* message) {
  std::fprintf(stdout, "[BallanceLeiaPresenter] %s\n", message);
  std::fflush(stdout);
}

void LogHr(const char* what, HRESULT hr) {
  std::fprintf(stdout, "[BallanceLeiaPresenter] %s failed hr=0x%08lx\n", what,
               static_cast<unsigned long>(hr));
  std::fflush(stdout);
}

// ---------------------------------------------------------------------------
// Received-frame mailbox
// ---------------------------------------------------------------------------

struct SharedTextureFrame {
  uint32_t sourcePid = 0;
  uint32_t pixelFormat = 0;
  uint32_t flags = 0;
  uint64_t handle = 0;
};

struct FrameMailbox {
  std::mutex mutex;
  std::vector<uint8_t> pixels;
  uint32_t frameId = 0;
  uint32_t width = 0;
  uint32_t height = 0;
  bool shared = false;
  SharedTextureFrame sharedFrame;
  bool hasNewFrame = false;

  void Publish(const uint8_t* data, size_t bytes, uint32_t id, uint32_t w,
               uint32_t h) {
    std::lock_guard<std::mutex> lock(mutex);
    pixels.assign(data, data + bytes);
    frameId = id;
    width = w;
    height = h;
    shared = false;
    hasNewFrame = true;
  }

  void PublishShared(const SharedTextureFrame& frame, uint32_t id, uint32_t w,
                     uint32_t h) {
    std::lock_guard<std::mutex> lock(mutex);
    pixels.clear();
    frameId = id;
    width = w;
    height = h;
    shared = true;
    sharedFrame = frame;
    hasNewFrame = true;
  }

  bool Take(uint32_t* id, uint32_t* w, uint32_t* h,
            std::vector<uint8_t>* out, bool* isShared,
            SharedTextureFrame* sharedOut) {
    std::lock_guard<std::mutex> lock(mutex);
    if (!hasNewFrame) return false;
    out->assign(pixels.begin(), pixels.end());
    *id = frameId;
    *w = width;
    *h = height;
    *isShared = shared;
    *sharedOut = sharedFrame;
    hasNewFrame = false;
    return true;
  }
};

// ---------------------------------------------------------------------------
// Pipe clients
// ---------------------------------------------------------------------------

HANDLE ConnectPipeWithRetry(const wchar_t* name, std::atomic<bool>* running) {
  while (running->load()) {
    HANDLE pipe = CreateFileW(name, GENERIC_READ | GENERIC_WRITE, 0, nullptr,
                              OPEN_EXISTING, 0, nullptr);
    if (pipe != INVALID_HANDLE_VALUE) return pipe;
    Sleep(250);
  }
  return INVALID_HANDLE_VALUE;
}

bool ReadExact(HANDLE pipe, uint8_t* data, size_t bytes) {
  size_t offset = 0;
  while (offset < bytes) {
    DWORD read = 0;
    if (!ReadFile(pipe, data + offset, static_cast<DWORD>(bytes - offset),
                  &read, nullptr) ||
        read == 0) {
      return false;
    }
    offset += read;
  }
  return true;
}

struct PipeThreads {
  std::atomic<bool> running{true};
  HANDLE framePipe = INVALID_HANDLE_VALUE;
  HANDLE ackPipe = INVALID_HANDLE_VALUE;
  HANDLE inputPipe = INVALID_HANDLE_VALUE;
  FrameMailbox mailbox;

  void Start() {
    framePipe = ConnectPipeWithRetry(kFramePipeName, &running);
    if (framePipe == INVALID_HANDLE_VALUE) return;
    ackPipe = ConnectPipeWithRetry(kAckPipeName, &running);
    if (ackPipe == INVALID_HANDLE_VALUE) return;
    inputPipe = ConnectPipeWithRetry(kInputPipeName, &running);
    if (inputPipe == INVALID_HANDLE_VALUE) return;
    Log("pipes connected");
    readerThread = CreateThread(nullptr, 0, ReaderEntry, this, 0, nullptr);
  }

  void Stop() {
    running.store(false);
    if (readerThread) {
      WaitForSingleObject(readerThread, 2000);
      CloseHandle(readerThread);
      readerThread = nullptr;
    }
    if (framePipe != INVALID_HANDLE_VALUE) CloseHandle(framePipe);
    if (ackPipe != INVALID_HANDLE_VALUE) CloseHandle(ackPipe);
    if (inputPipe != INVALID_HANDLE_VALUE) CloseHandle(inputPipe);
    framePipe = INVALID_HANDLE_VALUE;
    ackPipe = INVALID_HANDLE_VALUE;
    inputPipe = INVALID_HANDLE_VALUE;
  }

  // The presenter owns the foreground window, so Windows delivers the keys
  // here; Electron main injects them into the offscreen game page. Repeats are
  // forwarded too (the flag lets main mark isAutoRepeat).
  void SendKey(UINT message, WPARAM wParam, LPARAM lParam) {
    if (inputPipe == INVALID_HANDLE_VALUE) return;
    uint32_t flags = 0;
    if (message == WM_KEYUP || message == WM_SYSKEYUP) flags |= kKeyFlagUp;
    if ((lParam & (1ll << 30)) != 0) flags |= kKeyFlagRepeat;
    if ((lParam & (1ll << 24)) != 0) flags |= kKeyFlagExtended;
    if (GetKeyState(VK_SHIFT) & 0x8000) flags |= kKeyFlagShift;
    if (GetKeyState(VK_CONTROL) & 0x8000) flags |= kKeyFlagControl;
    if ((GetKeyState(VK_MENU) & 0x8000) ||
        message == WM_SYSKEYDOWN || message == WM_SYSKEYUP) {
      flags |= kKeyFlagAlt;
    }
    if (GetKeyState(VK_CAPITAL) & 1) flags |= kKeyFlagCapsLock;

    uint8_t input[kInputMessageBytes];
    const uint32_t words[5] = {
        kInputMagic,
        kInputKindKey,
        static_cast<uint32_t>(wParam),
        static_cast<uint32_t>((lParam >> 16) & 0xffffu),
        flags,
    };
    std::memcpy(input, words, sizeof(words));
    DWORD written = 0;
    WriteFile(inputPipe, input, sizeof(input), &written, nullptr);
  }

  bool SendAck(uint32_t frameId) {
    if (ackPipe == INVALID_HANDLE_VALUE) return false;
    uint8_t ack[kAckBytes];
    std::memcpy(ack, &kFrameMagic, 4);
    std::memcpy(ack + 4, &frameId, 4);
    DWORD written = 0;
    const BOOL ok = WriteFile(ackPipe, ack, sizeof(ack), &written, nullptr);
    if (!ok || written != sizeof(ack)) {
      std::fprintf(stdout,
                   "[BallanceLeiaPresenter] ack write failed frame=%u ok=%d written=%lu error=%lu\n",
                   frameId, ok ? 1 : 0, static_cast<unsigned long>(written),
                   static_cast<unsigned long>(GetLastError()));
      std::fflush(stdout);
      return false;
    }
    return true;
  }

  /** A control message on the input pipe (kind 2): vkCode = code, scanCode = frameId. */
  void SendControl(uint32_t code, uint32_t frameId) {
    if (inputPipe == INVALID_HANDLE_VALUE) return;
    uint8_t input[kInputMessageBytes];
    const uint32_t words[5] = {
        kInputMagic,
        kInputKindControl,
        code,
        frameId,
        0,
    };
    std::memcpy(input, words, sizeof(words));
    DWORD written = 0;
    WriteFile(inputPipe, input, sizeof(input), &written, nullptr);
  }

 private:
  static DWORD WINAPI ReaderEntry(LPVOID context) {
    static_cast<PipeThreads*>(context)->ReaderLoop();
    return 0;
  }

  void ReaderLoop() {
    std::vector<uint8_t> payload;
    while (running.load()) {
      uint8_t header[kFrameHeaderBytes];
      if (!ReadExact(framePipe, header, sizeof(header))) break;
      uint32_t magic = 0;
      uint32_t frameId = 0;
      uint32_t width = 0;
      uint32_t height = 0;
      uint32_t format = 0;
      uint32_t payloadBytes = 0;
      std::memcpy(&magic, header, 4);
      std::memcpy(&frameId, header + 4, 4);
      std::memcpy(&width, header + 8, 4);
      std::memcpy(&height, header + 12, 4);
      std::memcpy(&format, header + 16, 4);
      std::memcpy(&payloadBytes, header + 20, 4);
      if (magic != kFrameMagic || (format != kFrameFormatBgra8 && format != kFrameFormatSharedTexture) ||
          width == 0 || height == 0 || payloadBytes > 64u * 1024u * 1024u) {
        Log("invalid frame header");
        break;
      }
      if (format == kFrameFormatBgra8) {
        if (payloadBytes != width * height * 4) {
          Log("invalid pixel frame header");
          break;
        }
        payload.resize(payloadBytes);
        if (!ReadExact(framePipe, payload.data(), payloadBytes)) break;
        mailbox.Publish(payload.data(), payloadBytes, frameId, width, height);
        std::fprintf(stdout,
                     "[BallanceLeiaPresenter] frame received id=%u %ux%u\n",
                     frameId, width, height);
      } else {
        if (payloadBytes != kSharedTexturePayloadBytes) {
          Log("invalid shared texture frame header");
          break;
        }
        payload.resize(payloadBytes);
        if (!ReadExact(framePipe, payload.data(), payloadBytes)) break;
        SharedTextureFrame frame;
        std::memcpy(&frame.sourcePid, payload.data(), 4);
        std::memcpy(&frame.pixelFormat, payload.data() + 4, 4);
        std::memcpy(&frame.flags, payload.data() + 8, 4);
        std::memcpy(&frame.handle, payload.data() + 16, 8);
        mailbox.PublishShared(frame, frameId, width, height);
        std::fprintf(stdout,
                     "[BallanceLeiaPresenter] shared texture received id=%u %ux%u pid=%u\n",
                     frameId, width, height, frame.sourcePid);
      }
      std::fflush(stdout);
    }
    running.store(false);
    Log("frame pipe closed");
  }

  HANDLE readerThread = nullptr;
};

// ---------------------------------------------------------------------------
// DX12 presenter
// ---------------------------------------------------------------------------

struct Presenter {
  HWND hwnd = nullptr;
  IDXGIFactory4* factory = nullptr;
  ID3D12Device* device = nullptr;
  ID3D12CommandQueue* queue = nullptr;
  IDXGISwapChain3* swapChain = nullptr;
  ID3D12DescriptorHeap* rtvHeap = nullptr;
  ID3D12DescriptorHeap* srvHeap = nullptr;
  ID3D12Resource* renderTargets[kSwapChainBufferCount] = {};
  ID3D12CommandAllocator* allocator = nullptr;
  ID3D12GraphicsCommandList* commandList = nullptr;
  ID3D12RootSignature* rootSignature = nullptr;
  ID3D12PipelineState* pipelineState = nullptr;
  ID3D12Fence* fence = nullptr;
  HANDLE fenceEvent = nullptr;
  uint64_t fenceValue = 0;
  uint32_t rtvDescriptorSize = 0;
  uint32_t srvDescriptorSize = 0;
  ID3D12Resource* texture = nullptr;
  ID3D12Resource* uploadBuffer = nullptr;
  uint8_t* uploadMapped = nullptr;
  uint32_t textureWidth = 0;
  uint32_t textureHeight = 0;
  uint32_t uploadRowPitch = 0;
  // LeiaSR weave (step 3). The weaver consumes the full side-by-side image at
  // twice the swap-chain width; the received half-SbS frame is stretched into
  // this compose texture before every weave.
  ID3D12PipelineState* stretchPipelineState = nullptr;
  ID3D12Resource* composeTexture = nullptr;
  uint32_t composeWidth = 0;
  uint32_t composeHeight = 0;
  bool composeIsRenderTarget = false;
  // App-owned weave output (panel extent, BGRA). The SDK weaves into this and
  // the result is blitted to the swap chain: weaving straight into a swap-chain
  // buffer is the path that produced black frames, RAM growth and device
  // removal on SR panels in the reference implementation.
  ID3D12Resource* weaveTexture = nullptr;
  uint32_t weaveWidth = 0;
  uint32_t weaveHeight = 0;
  bool weaveIsRenderTarget = false;
  // One frame of plain side-by-side after the weave target is (re)created, so
  // the panel/swap chain settles before the first weave into the new surface.
  bool weaveSettled = true;
  // Remote hardware-evidence capture: writes the presented frame (post-weave
  // when SR is active) and the full-SbS compose input as BMPs for a panel
  // owner to return. Wide: the capture path comes from the command line and
  // must survive non-ASCII directories.
  std::wstring captureDir;
  uint32_t captureFramesRemaining = 0;
  bool deviceLost = false;
  bool fullscreenOnMonitor = false;
#if defined(BALLANCE_LEIA_SR)
  SimulatedReality::SRInterfaceDX12* srInterface = nullptr;
  bool srAttempted = false;
  DXGI_FORMAT srOutputFormat = DXGI_FORMAT_UNKNOWN;
#endif

  bool Initialize(HWND window) {
    hwnd = window;
    if (!CreateDevice()) return false;
    if (!CreateSwapChain()) return false;
    if (!CreatePipeline()) return false;
    if (!CreateSync()) return false;
    InitializeSr();
    return true;
  }

  bool CreateDevice() {
    if (GetEnvironmentVariableW(L"BALLANCE_LEIA_DEBUG", nullptr, 0) > 0) {
      ID3D12Debug* debug = nullptr;
      if (SUCCEEDED(D3D12GetDebugInterface(IID_PPV_ARGS(&debug)))) {
        debug->EnableDebugLayer();
        debug->Release();
        Log("debug layer enabled");
      }
    }
    UINT factoryFlags = 0;
#if defined(_DEBUG)
    factoryFlags |= DXGI_CREATE_FACTORY_DEBUG;
#endif
    HRESULT hr = CreateDXGIFactory2(factoryFlags, IID_PPV_ARGS(&factory));
    if (FAILED(hr)) {
      LogHr("CreateDXGIFactory2", hr);
      return false;
    }
    IDXGIAdapter1* adapter = nullptr;
    for (UINT index = 0; factory->EnumAdapters1(index, &adapter) != DXGI_ERROR_NOT_FOUND;
         ++index) {
      DXGI_ADAPTER_DESC1 desc = {};
      adapter->GetDesc1(&desc);
      if ((desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) == 0) break;
      adapter->Release();
      adapter = nullptr;
    }
    hr = D3D12CreateDevice(adapter, D3D_FEATURE_LEVEL_11_0, IID_PPV_ARGS(&device));
    if (adapter) adapter->Release();
    if (FAILED(hr)) {
      LogHr("D3D12CreateDevice", hr);
      return false;
    }
    D3D12_COMMAND_QUEUE_DESC queueDesc = {};
    queueDesc.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
    hr = device->CreateCommandQueue(&queueDesc, IID_PPV_ARGS(&queue));
    if (FAILED(hr)) {
      LogHr("CreateCommandQueue", hr);
      return false;
    }
    return true;
  }

  bool CreateSwapChain() {
    RECT client = {};
    GetClientRect(hwnd, &client);
    DXGI_SWAP_CHAIN_DESC1 desc = {};
    desc.Width = static_cast<UINT>(client.right - client.left);
    desc.Height = static_cast<UINT>(client.bottom - client.top);
    desc.Format = kSwapChainFormat;
    desc.Stereo = FALSE;
    desc.SampleDesc.Count = 1;
    desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    desc.BufferCount = kSwapChainBufferCount;
    desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
    desc.AlphaMode = DXGI_ALPHA_MODE_IGNORE;
    desc.Flags = 0;
    IDXGISwapChain1* swapChain1 = nullptr;
    HRESULT hr = factory->CreateSwapChainForHwnd(
        queue, hwnd, &desc, nullptr, nullptr, &swapChain1);
    if (FAILED(hr)) {
      LogHr("CreateSwapChainForHwnd", hr);
      return false;
    }
    factory->MakeWindowAssociation(hwnd, DXGI_MWA_NO_ALT_ENTER);
    hr = swapChain1->QueryInterface(IID_PPV_ARGS(&swapChain));
    swapChain1->Release();
    if (FAILED(hr)) {
      LogHr("QueryInterface swapchain", hr);
      return false;
    }

    D3D12_DESCRIPTOR_HEAP_DESC rtvDesc = {};
    rtvDesc.Type = D3D12_DESCRIPTOR_HEAP_TYPE_RTV;
    // + compose target + app-owned weave target
    rtvDesc.NumDescriptors = kSwapChainBufferCount + 2;
    hr = device->CreateDescriptorHeap(&rtvDesc, IID_PPV_ARGS(&rtvHeap));
    if (FAILED(hr)) {
      LogHr("CreateDescriptorHeap rtv", hr);
      return false;
    }
    rtvDescriptorSize = device->GetDescriptorHandleIncrementSize(
        D3D12_DESCRIPTOR_HEAP_TYPE_RTV);
    CreateRenderTargets();

    D3D12_DESCRIPTOR_HEAP_DESC srvDesc = {};
    srvDesc.Type = D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV;
    // 0: received frame, 1: app-owned weave output
    srvDesc.NumDescriptors = 3;
    srvDesc.Flags = D3D12_DESCRIPTOR_HEAP_FLAG_SHADER_VISIBLE;
    hr = device->CreateDescriptorHeap(&srvDesc, IID_PPV_ARGS(&srvHeap));
    if (FAILED(hr)) {
      LogHr("CreateDescriptorHeap srv", hr);
      return false;
    }
    srvDescriptorSize = device->GetDescriptorHandleIncrementSize(
        D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV);
    return true;
  }

  void CreateRenderTargets() {
    D3D12_CPU_DESCRIPTOR_HANDLE handle =
        rtvHeap->GetCPUDescriptorHandleForHeapStart();
    for (UINT index = 0; index < kSwapChainBufferCount; ++index) {
      swapChain->GetBuffer(index, IID_PPV_ARGS(&renderTargets[index]));
      device->CreateRenderTargetView(renderTargets[index], nullptr, handle);
      handle.ptr += rtvDescriptorSize;
    }
  }

  void ReleaseRenderTargets() {
    for (UINT index = 0; index < kSwapChainBufferCount; ++index) {
      if (renderTargets[index]) renderTargets[index]->Release();
      renderTargets[index] = nullptr;
    }
  }

  bool CreatePipeline() {
    D3D12_ROOT_PARAMETER rootParameter = {};
    rootParameter.ParameterType = D3D12_ROOT_PARAMETER_TYPE_DESCRIPTOR_TABLE;
    D3D12_DESCRIPTOR_RANGE range = {};
    range.RangeType = D3D12_DESCRIPTOR_RANGE_TYPE_SRV;
    range.NumDescriptors = 1;
    range.BaseShaderRegister = 0;
    rootParameter.DescriptorTable.NumDescriptorRanges = 1;
    rootParameter.DescriptorTable.pDescriptorRanges = &range;
    rootParameter.ShaderVisibility = D3D12_SHADER_VISIBILITY_PIXEL;

    D3D12_STATIC_SAMPLER_DESC sampler = {};
    sampler.Filter = D3D12_FILTER_MIN_MAG_MIP_LINEAR;
    sampler.AddressU = D3D12_TEXTURE_ADDRESS_MODE_CLAMP;
    sampler.AddressV = D3D12_TEXTURE_ADDRESS_MODE_CLAMP;
    sampler.AddressW = D3D12_TEXTURE_ADDRESS_MODE_CLAMP;
    sampler.ShaderRegister = 0;
    sampler.ShaderVisibility = D3D12_SHADER_VISIBILITY_PIXEL;

    D3D12_ROOT_SIGNATURE_DESC rootDesc = {};
    rootDesc.NumParameters = 1;
    rootDesc.pParameters = &rootParameter;
    rootDesc.NumStaticSamplers = 1;
    rootDesc.pStaticSamplers = &sampler;
    rootDesc.Flags = D3D12_ROOT_SIGNATURE_FLAG_ALLOW_INPUT_ASSEMBLER_INPUT_LAYOUT;
    ID3DBlob* signature = nullptr;
    ID3DBlob* error = nullptr;
    HRESULT hr = D3D12SerializeRootSignature(
        &rootDesc, D3D_ROOT_SIGNATURE_VERSION_1, &signature, &error);
    if (FAILED(hr)) {
      LogHr("D3D12SerializeRootSignature", hr);
      if (error) error->Release();
      return false;
    }
    hr = device->CreateRootSignature(0, signature->GetBufferPointer(),
                                     signature->GetBufferSize(),
                                     IID_PPV_ARGS(&rootSignature));
    signature->Release();
    if (error) error->Release();
    if (FAILED(hr)) {
      LogHr("CreateRootSignature", hr);
      return false;
    }

    static const char* kShaderSource = R"(
      struct VSOut { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };
      VSOut VSMain(uint id : SV_VertexID) {
        VSOut o;
        float2 uv = float2((id << 1) & 2, id & 2);
        o.uv = uv;
        o.pos = float4(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
        return o;
      }
      Texture2D frameTexture : register(t0);
      SamplerState frameSampler : register(s0);
      float4 PSMain(VSOut i) : SV_TARGET {
        return frameTexture.Sample(frameSampler, i.uv);
      }
    )";
    ID3DBlob* vertexShader = nullptr;
    ID3DBlob* pixelShader = nullptr;
    hr = D3DCompile(kShaderSource, std::strlen(kShaderSource), nullptr, nullptr,
                    nullptr, "VSMain", "vs_5_0", 0, 0, &vertexShader, &error);
    if (FAILED(hr)) {
      LogHr("D3DCompile vs", hr);
      if (error) error->Release();
      return false;
    }
    hr = D3DCompile(kShaderSource, std::strlen(kShaderSource), nullptr, nullptr,
                    nullptr, "PSMain", "ps_5_0", 0, 0, &pixelShader, &error);
    if (FAILED(hr)) {
      LogHr("D3DCompile ps", hr);
      vertexShader->Release();
      if (error) error->Release();
      return false;
    }

    D3D12_GRAPHICS_PIPELINE_STATE_DESC psoDesc = {};
    psoDesc.pRootSignature = rootSignature;
    psoDesc.VS = {vertexShader->GetBufferPointer(), vertexShader->GetBufferSize()};
    psoDesc.PS = {pixelShader->GetBufferPointer(), pixelShader->GetBufferSize()};
    psoDesc.RasterizerState.FillMode = D3D12_FILL_MODE_SOLID;
    psoDesc.RasterizerState.CullMode = D3D12_CULL_MODE_NONE;
    psoDesc.RasterizerState.DepthClipEnable = TRUE;
    psoDesc.BlendState.RenderTarget[0].RenderTargetWriteMask =
        D3D12_COLOR_WRITE_ENABLE_ALL;
    psoDesc.DepthStencilState.DepthEnable = FALSE;
    psoDesc.DepthStencilState.StencilEnable = FALSE;
    psoDesc.SampleMask = UINT_MAX;
    psoDesc.PrimitiveTopologyType = D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE;
    psoDesc.NumRenderTargets = 1;
    psoDesc.RTVFormats[0] = kSwapChainFormat;
    psoDesc.SampleDesc.Count = 1;
    hr = device->CreateGraphicsPipelineState(&psoDesc, IID_PPV_ARGS(&pipelineState));
    vertexShader->Release();
    pixelShader->Release();
    if (FAILED(hr)) {
      LogHr("CreateGraphicsPipelineState", hr);
      DumpDebugMessages();
      return false;
    }

    // Stretch pass: the received half-SbS frame becomes the full-SbS 2W x H
    // input the DX12 weaver consumes (L in the left half, R in the right).
    static const char* kStretchShaderSource = R"(
      struct VSOut { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };
      VSOut VSStretch(uint id : SV_VertexID) {
        VSOut o;
        float2 uv = float2((id << 1) & 2, id & 2);
        o.uv = uv;
        o.pos = float4(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
        return o;
      }
      Texture2D frameTexture : register(t0);
      SamplerState frameSampler : register(s0);
      float4 PSStretch(VSOut i) : SV_TARGET {
        float eye = i.uv.x < 0.5 ? 0.0 : 1.0;
        float local = i.uv.x < 0.5 ? i.uv.x * 2.0 : (i.uv.x - 0.5) * 2.0;
        float2 sourceUv = float2(eye * 0.5 + local * 0.5, i.uv.y);
        return frameTexture.Sample(frameSampler, sourceUv);
      }
    )";
    ID3DBlob* stretchVertexShader = nullptr;
    ID3DBlob* stretchPixelShader = nullptr;
    hr = D3DCompile(kStretchShaderSource, std::strlen(kStretchShaderSource),
                    nullptr, nullptr, nullptr, "VSStretch", "vs_5_0", 0, 0,
                    &stretchVertexShader, &error);
    if (FAILED(hr)) {
      LogHr("D3DCompile stretch vs", hr);
      if (error) error->Release();
      return false;
    }
    hr = D3DCompile(kStretchShaderSource, std::strlen(kStretchShaderSource),
                    nullptr, nullptr, nullptr, "PSStretch", "ps_5_0", 0, 0,
                    &stretchPixelShader, &error);
    if (FAILED(hr)) {
      LogHr("D3DCompile stretch ps", hr);
      stretchVertexShader->Release();
      if (error) error->Release();
      return false;
    }
    D3D12_GRAPHICS_PIPELINE_STATE_DESC stretchDesc = psoDesc;
    stretchDesc.VS = {stretchVertexShader->GetBufferPointer(),
                      stretchVertexShader->GetBufferSize()};
    stretchDesc.PS = {stretchPixelShader->GetBufferPointer(),
                      stretchPixelShader->GetBufferSize()};
    hr = device->CreateGraphicsPipelineState(&stretchDesc,
                                             IID_PPV_ARGS(&stretchPipelineState));
    stretchVertexShader->Release();
    stretchPixelShader->Release();
    if (FAILED(hr)) {
      LogHr("CreateGraphicsPipelineState stretch", hr);
      DumpDebugMessages();
      return false;
    }

    hr = device->CreateCommandAllocator(D3D12_COMMAND_LIST_TYPE_DIRECT,
                                        IID_PPV_ARGS(&allocator));
    if (FAILED(hr)) {
      LogHr("CreateCommandAllocator", hr);
      return false;
    }
    hr = device->CreateCommandList(0, D3D12_COMMAND_LIST_TYPE_DIRECT, allocator,
                                   pipelineState, IID_PPV_ARGS(&commandList));
    if (FAILED(hr)) {
      LogHr("CreateCommandList", hr);
      return false;
    }
    commandList->Close();
    return true;
  }

  bool CreateSync() {
    HRESULT hr = device->CreateFence(0, D3D12_FENCE_FLAG_NONE, IID_PPV_ARGS(&fence));
    if (FAILED(hr)) {
      LogHr("CreateFence", hr);
      return false;
    }
    fenceEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    return fenceEvent != nullptr;
  }

  bool EnsureTexture(uint32_t width, uint32_t height) {
    if (texture && textureWidth == width && textureHeight == height) return true;
    ReleaseTexture();

    D3D12_RESOURCE_DESC textureDesc = {};
    textureDesc.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    textureDesc.Width = width;
    textureDesc.Height = height;
    textureDesc.DepthOrArraySize = 1;
    textureDesc.MipLevels = 1;
    textureDesc.Format = kFrameTextureFormat;
    textureDesc.SampleDesc.Count = 1;
    textureDesc.Layout = D3D12_TEXTURE_LAYOUT_UNKNOWN;
    D3D12_HEAP_PROPERTIES defaultHeap = {};
    defaultHeap.Type = D3D12_HEAP_TYPE_DEFAULT;
    HRESULT hr = device->CreateCommittedResource(
        &defaultHeap, D3D12_HEAP_FLAG_NONE, &textureDesc,
        D3D12_RESOURCE_STATE_COPY_DEST, nullptr, IID_PPV_ARGS(&texture));
    if (FAILED(hr)) {
      LogHr("CreateTexture", hr);
      return false;
    }

    uploadRowPitch = (width * 4 + D3D12_TEXTURE_DATA_PITCH_ALIGNMENT - 1) &
                     ~(D3D12_TEXTURE_DATA_PITCH_ALIGNMENT - 1);
    const uint64_t uploadBytes =
        static_cast<uint64_t>(uploadRowPitch) * height;
    D3D12_RESOURCE_DESC uploadDesc = {};
    uploadDesc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    uploadDesc.Width = uploadBytes;
    uploadDesc.Height = 1;
    uploadDesc.DepthOrArraySize = 1;
    uploadDesc.MipLevels = 1;
    uploadDesc.Format = DXGI_FORMAT_UNKNOWN;
    uploadDesc.SampleDesc.Count = 1;
    uploadDesc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
    D3D12_HEAP_PROPERTIES uploadHeap = {};
    uploadHeap.Type = D3D12_HEAP_TYPE_UPLOAD;
    hr = device->CreateCommittedResource(
        &uploadHeap, D3D12_HEAP_FLAG_NONE, &uploadDesc,
        D3D12_RESOURCE_STATE_GENERIC_READ, nullptr, IID_PPV_ARGS(&uploadBuffer));
    if (FAILED(hr)) {
      LogHr("CreateUploadBuffer", hr);
      return false;
    }
    hr = uploadBuffer->Map(0, nullptr, reinterpret_cast<void**>(&uploadMapped));
    if (FAILED(hr)) {
      LogHr("MapUploadBuffer", hr);
      return false;
    }

    D3D12_SHADER_RESOURCE_VIEW_DESC srvDesc = {};
    srvDesc.Format = kFrameTextureFormat;
    srvDesc.ViewDimension = D3D12_SRV_DIMENSION_TEXTURE2D;
    srvDesc.Shader4ComponentMapping = D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
    srvDesc.Texture2D.MipLevels = 1;
    device->CreateShaderResourceView(
        texture, &srvDesc, srvHeap->GetCPUDescriptorHandleForHeapStart());

    textureWidth = width;
    textureHeight = height;
    Log("texture created");
    return true;
  }

  void ReleaseTexture() {
    if (uploadBuffer && uploadMapped) {
      uploadBuffer->Unmap(0, nullptr);
      uploadMapped = nullptr;
    }
    if (uploadBuffer) uploadBuffer->Release();
    if (texture) texture->Release();
    uploadBuffer = nullptr;
    texture = nullptr;
    textureWidth = 0;
    textureHeight = 0;
  }

  // Full-SbS intermediate for the weaver: 2 x swap-chain width x swap-chain
  // height, same format as the swap chain. The received half-SbS frame is
  // stretched into it once per frame.
  bool EnsureCompose(uint32_t swapWidth, uint32_t swapHeight) {
    const uint32_t width = swapWidth * 2;
    const uint32_t height = swapHeight;
    if (composeTexture && composeWidth == width && composeHeight == height) {
      return true;
    }
    ReleaseCompose();
    D3D12_RESOURCE_DESC textureDesc = {};
    textureDesc.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    textureDesc.Width = width;
    textureDesc.Height = height;
    textureDesc.DepthOrArraySize = 1;
    textureDesc.MipLevels = 1;
    // The weaver input must be B8G8R8A8 (the SDK pipeline's byte order); the
    // stretch shader writes the same logical color into it.
    textureDesc.Format = kSwapChainFormat;
    textureDesc.SampleDesc.Count = 1;
    textureDesc.Layout = D3D12_TEXTURE_LAYOUT_UNKNOWN;
    // Must be set: the compose texture starts in RENDER_TARGET state and is
    // rendered into by the stretch pass.
    textureDesc.Flags = D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET;
    D3D12_HEAP_PROPERTIES defaultHeap = {};
    defaultHeap.Type = D3D12_HEAP_TYPE_DEFAULT;
    HRESULT hr = device->CreateCommittedResource(
        &defaultHeap, D3D12_HEAP_FLAG_NONE, &textureDesc,
        D3D12_RESOURCE_STATE_RENDER_TARGET, nullptr,
        IID_PPV_ARGS(&composeTexture));
    if (FAILED(hr)) {
      LogHr("CreateComposeTexture", hr);
      return false;
    }
    D3D12_CPU_DESCRIPTOR_HANDLE rtv =
        rtvHeap->GetCPUDescriptorHandleForHeapStart();
    rtv.ptr += static_cast<SIZE_T>(kSwapChainBufferCount) * rtvDescriptorSize;
    device->CreateRenderTargetView(composeTexture, nullptr, rtv);
    composeWidth = width;
    composeHeight = height;
    composeIsRenderTarget = true;
    Log("compose texture created");
    return true;
  }

  void ReleaseCompose() {
    if (composeTexture) composeTexture->Release();
    composeTexture = nullptr;
    composeWidth = 0;
    composeHeight = 0;
    composeIsRenderTarget = false;
  }

  // App-owned weave output at panel extent. The SDK weaves into this texture
  // and the normal blit presents it; never weave into a swap-chain buffer (see
  // the hardware notes at the top of the file). Extents are forced even so each
  // eye half is integral.
  bool EnsureWeaveTexture(uint32_t panelWidth, uint32_t panelHeight) {
    const uint32_t width = panelWidth & ~1u;
    const uint32_t height = panelHeight & ~1u;
    if (width == 0 || height == 0) return false;
    if (weaveTexture && weaveWidth == width && weaveHeight == height) {
      return true;
    }
    ReleaseWeaveTexture();
    D3D12_RESOURCE_DESC textureDesc = {};
    textureDesc.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    textureDesc.Width = width;
    textureDesc.Height = height;
    textureDesc.DepthOrArraySize = 1;
    textureDesc.MipLevels = 1;
    textureDesc.Format = kSwapChainFormat;
    textureDesc.SampleDesc.Count = 1;
    textureDesc.Layout = D3D12_TEXTURE_LAYOUT_UNKNOWN;
    textureDesc.Flags = D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET;
    D3D12_HEAP_PROPERTIES defaultHeap = {};
    defaultHeap.Type = D3D12_HEAP_TYPE_DEFAULT;
    HRESULT hr = device->CreateCommittedResource(
        &defaultHeap, D3D12_HEAP_FLAG_NONE, &textureDesc,
        D3D12_RESOURCE_STATE_RENDER_TARGET, nullptr,
        IID_PPV_ARGS(&weaveTexture));
    if (FAILED(hr)) {
      LogHr("CreateWeaveTexture", hr);
      return false;
    }
    D3D12_CPU_DESCRIPTOR_HANDLE rtv =
        rtvHeap->GetCPUDescriptorHandleForHeapStart();
    rtv.ptr += static_cast<SIZE_T>(kSwapChainBufferCount + 1) * rtvDescriptorSize;
    device->CreateRenderTargetView(weaveTexture, nullptr, rtv);
    D3D12_SHADER_RESOURCE_VIEW_DESC srvDesc = {};
    srvDesc.Format = kSwapChainFormat;
    srvDesc.ViewDimension = D3D12_SRV_DIMENSION_TEXTURE2D;
    srvDesc.Shader4ComponentMapping = D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
    srvDesc.Texture2D.MipLevels = 1;
    D3D12_CPU_DESCRIPTOR_HANDLE srv =
        srvHeap->GetCPUDescriptorHandleForHeapStart();
    srv.ptr += srvDescriptorSize;
    device->CreateShaderResourceView(weaveTexture, &srvDesc, srv);
    weaveWidth = width;
    weaveHeight = height;
    weaveIsRenderTarget = true;
    // Give the panel/swap chain one frame to settle before weaving into the
    // new surface.
    weaveSettled = false;
    Log("weave texture created");
    return true;
  }

  void ReleaseWeaveTexture() {
    if (weaveTexture) weaveTexture->Release();
    weaveTexture = nullptr;
    weaveWidth = 0;
    weaveHeight = 0;
    weaveIsRenderTarget = false;
    weaveSettled = true;
  }

  D3D12_CPU_DESCRIPTOR_HANDLE WeaveRtv() const {
    D3D12_CPU_DESCRIPTOR_HANDLE rtv =
        rtvHeap->GetCPUDescriptorHandleForHeapStart();
    rtv.ptr += static_cast<SIZE_T>(kSwapChainBufferCount + 1) * rtvDescriptorSize;
    return rtv;
  }

  D3D12_GPU_DESCRIPTOR_HANDLE WeaveSrv() const {
    D3D12_GPU_DESCRIPTOR_HANDLE srv =
        srvHeap->GetGPUDescriptorHandleForHeapStart();
    srv.ptr += srvDescriptorSize;
    return srv;
  }

  // Slot 2 holds the current Electron shared texture. It is rewritten every
  // shared frame (the compositor hands out a pool of textures).
  D3D12_CPU_DESCRIPTOR_HANDLE SharedSrvCpu() const {
    D3D12_CPU_DESCRIPTOR_HANDLE srv =
        srvHeap->GetCPUDescriptorHandleForHeapStart();
    srv.ptr += static_cast<SIZE_T>(2) * srvDescriptorSize;
    return srv;
  }

  D3D12_GPU_DESCRIPTOR_HANDLE SharedSrvGpu() const {
    D3D12_GPU_DESCRIPTOR_HANDLE srv =
        srvHeap->GetGPUDescriptorHandleForHeapStart();
    srv.ptr += static_cast<SIZE_T>(2) * srvDescriptorSize;
    return srv;
  }

#if defined(BALLANCE_LEIA_SR)
  void InitializeSr() {
    if (srAttempted) return;
    srAttempted = true;
    SimulatedReality::SRInterfaceDX12* sr = nullptr;
    HRESULT hr = E_FAIL;
    try {
      hr = SimulatedReality::CreateSRInterfaceDX12(device, hwnd, &sr);
    } catch (const std::exception& error) {
      std::fprintf(stdout,
                   "[BallanceLeiaPresenter] CreateSRInterfaceDX12 threw: %s\n",
                   error.what());
      std::fflush(stdout);
      return;
    }
    if (FAILED(hr) || sr == nullptr) {
      std::fprintf(stdout,
                   "[BallanceLeiaPresenter] LeiaSR unavailable (hr 0x%08lx); presenting plain side-by-side\n",
                   static_cast<unsigned long>(hr));
      std::fflush(stdout);
      return;
    }
    srInterface = sr;
    srOutputFormat = DXGI_FORMAT_UNKNOWN;
    // The compose intermediate and the weave output are both plain UNORM and
    // the web compose already carries the game's gamma, so the weaver must not
    // apply sRGB conversions in either direction (matches the RT64 reference).
    srInterface->SetShaderSRGBConversion(false, false);
    Log("LeiaSR weaver initialized");
  }

  // Tear the weaver down and latch it off for this device. Delete() can throw
  // when the device was lost under the weaver; that must not escape teardown.
  void DisableSr() {
    if (!srInterface) return;
    SimulatedReality::SRDisableLensHint();
    try {
      srInterface->Delete();
    } catch (const std::exception& error) {
      std::fprintf(stdout, "[BallanceLeiaPresenter] SR Delete threw: %s\n",
                   error.what());
      std::fflush(stdout);
    }
    srInterface = nullptr;
    srOutputFormat = DXGI_FORMAT_UNKNOWN;
  }

  void ShutdownSr() { DisableSr(); }

  bool IsSrActive() const { return srInterface != nullptr; }
#else
  void InitializeSr() { Log("built without SR-lib; presenting plain side-by-side"); }
  void DisableSr() {}
  void ShutdownSr() {}
  bool IsSrActive() const { return false; }
#endif

  // Records the half-SbS -> full-SbS stretch into the compose texture. The
  // command list must be open with the received-texture SRV bound.
  void RecordStretchPass() {
    const float clear[4] = {0.0f, 0.0f, 0.0f, 1.0f};
    if (!composeIsRenderTarget) {
      D3D12_RESOURCE_BARRIER toComposeTarget = {};
      toComposeTarget.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
      toComposeTarget.Transition.pResource = composeTexture;
      toComposeTarget.Transition.Subresource =
          D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
      toComposeTarget.Transition.StateBefore =
          D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;
      toComposeTarget.Transition.StateAfter = D3D12_RESOURCE_STATE_RENDER_TARGET;
      commandList->ResourceBarrier(1, &toComposeTarget);
      composeIsRenderTarget = true;
    }
    D3D12_CPU_DESCRIPTOR_HANDLE composeRtv =
        rtvHeap->GetCPUDescriptorHandleForHeapStart();
    composeRtv.ptr += static_cast<SIZE_T>(kSwapChainBufferCount) * rtvDescriptorSize;
    commandList->OMSetRenderTargets(1, &composeRtv, FALSE, nullptr);
    commandList->ClearRenderTargetView(composeRtv, clear, 0, nullptr);
    D3D12_VIEWPORT composeViewport = {
        0.0f, 0.0f, static_cast<float>(composeWidth),
        static_cast<float>(composeHeight), 0.0f, 1.0f};
    D3D12_RECT composeScissor = {
        0, 0, static_cast<LONG>(composeWidth), static_cast<LONG>(composeHeight)};
    commandList->RSSetViewports(1, &composeViewport);
    commandList->RSSetScissorRects(1, &composeScissor);
    commandList->SetPipelineState(stretchPipelineState);
    commandList->DrawInstanced(3, 1, 0, 0);

    D3D12_RESOURCE_BARRIER composeToRead = {};
    composeToRead.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    composeToRead.Transition.pResource = composeTexture;
    composeToRead.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    composeToRead.Transition.StateBefore = D3D12_RESOURCE_STATE_RENDER_TARGET;
    composeToRead.Transition.StateAfter = D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;
    commandList->ResourceBarrier(1, &composeToRead);
    composeIsRenderTarget = false;
  }

  bool ReadbackResource(ID3D12Resource* source, D3D12_RESOURCE_STATES sourceState,
                        std::vector<uint8_t>* out, uint32_t* outWidth,
                        uint32_t* outHeight) {
    const D3D12_RESOURCE_DESC desc = source->GetDesc();
    const uint32_t width = static_cast<uint32_t>(desc.Width);
    const uint32_t height = desc.Height;
    const uint32_t rowPitch =
        (width * 4 + D3D12_TEXTURE_DATA_PITCH_ALIGNMENT - 1)
        & ~(D3D12_TEXTURE_DATA_PITCH_ALIGNMENT - 1);
    D3D12_RESOURCE_DESC bufferDesc = {};
    bufferDesc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    bufferDesc.Width = static_cast<UINT64>(rowPitch) * height;
    bufferDesc.Height = 1;
    bufferDesc.DepthOrArraySize = 1;
    bufferDesc.MipLevels = 1;
    bufferDesc.Format = DXGI_FORMAT_UNKNOWN;
    bufferDesc.SampleDesc.Count = 1;
    bufferDesc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
    D3D12_HEAP_PROPERTIES readbackHeap = {};
    readbackHeap.Type = D3D12_HEAP_TYPE_READBACK;
    ID3D12Resource* readback = nullptr;
    HRESULT hr = device->CreateCommittedResource(
        &readbackHeap, D3D12_HEAP_FLAG_NONE, &bufferDesc,
        D3D12_RESOURCE_STATE_COPY_DEST, nullptr, IID_PPV_ARGS(&readback));
    if (FAILED(hr)) {
      LogHr("CreateReadbackBuffer", hr);
      return false;
    }
    allocator->Reset();
    commandList->Reset(allocator, pipelineState);
    commandList->SetGraphicsRootSignature(rootSignature);
    D3D12_RESOURCE_BARRIER toCopy = {};
    toCopy.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    toCopy.Transition.pResource = source;
    toCopy.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    toCopy.Transition.StateBefore = sourceState;
    toCopy.Transition.StateAfter = D3D12_RESOURCE_STATE_COPY_SOURCE;
    commandList->ResourceBarrier(1, &toCopy);
    D3D12_TEXTURE_COPY_LOCATION copySource = {};
    copySource.pResource = source;
    copySource.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
    copySource.SubresourceIndex = 0;
    D3D12_TEXTURE_COPY_LOCATION copyDest = {};
    copyDest.pResource = readback;
    copyDest.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
    copyDest.PlacedFootprint.Footprint.Format = desc.Format;
    copyDest.PlacedFootprint.Footprint.Width = width;
    copyDest.PlacedFootprint.Footprint.Height = height;
    copyDest.PlacedFootprint.Footprint.Depth = 1;
    copyDest.PlacedFootprint.Footprint.RowPitch = rowPitch;
    commandList->CopyTextureRegion(&copyDest, 0, 0, 0, &copySource, nullptr);
    D3D12_RESOURCE_BARRIER restore = toCopy;
    restore.Transition.StateBefore = D3D12_RESOURCE_STATE_COPY_SOURCE;
    restore.Transition.StateAfter = sourceState;
    commandList->ResourceBarrier(1, &restore);
    commandList->Close();
    ID3D12CommandList* lists[] = {commandList};
    queue->ExecuteCommandLists(1, lists);
    WaitForGpu();
    void* mapped = nullptr;
    hr = readback->Map(0, nullptr, &mapped);
    if (FAILED(hr)) {
      LogHr("MapReadback", hr);
      readback->Release();
      return false;
    }
    out->assign(static_cast<size_t>(width) * height * 4, 0);
    const uint8_t* base = static_cast<const uint8_t*>(mapped);
    for (uint32_t row = 0; row < height; row += 1) {
      std::memcpy(out->data() + static_cast<size_t>(row) * width * 4,
                  base + static_cast<size_t>(row) * rowPitch,
                  static_cast<size_t>(width) * 4);
    }
    readback->Unmap(0, nullptr);
    readback->Release();
    *outWidth = width;
    *outHeight = height;
    return true;
  }

  bool WriteBmp(const std::wstring& filePath, const std::vector<uint8_t>& pixels,
                uint32_t width, uint32_t height) {
    const uint32_t rowBytes = width * 4;
    const uint32_t imageBytes = rowBytes * height;
    const uint32_t fileBytes = 54 + imageBytes;
    std::vector<uint8_t> file(fileBytes, 0);
    file[0] = 'B';
    file[1] = 'M';
    std::memcpy(&file[2], &fileBytes, 4);
    const uint32_t offset = 54;
    std::memcpy(&file[10], &offset, 4);
    const uint32_t dibSize = 40;
    std::memcpy(&file[14], &dibSize, 4);
    std::memcpy(&file[18], &width, 4);
    std::memcpy(&file[22], &height, 4);
    const uint16_t planes = 1;
    std::memcpy(&file[26], &planes, 2);
    const uint16_t bits = 32;
    std::memcpy(&file[28], &bits, 2);
    std::memcpy(&file[34], &imageBytes, 4);
    for (uint32_t y = 0; y < height; y += 1) {
      const uint8_t* sourceRow = pixels.data() + static_cast<size_t>(y) * rowBytes;
      // All readbacks are B8G8R8A8 (weave chain and swap chain), which is
      // exactly BMP's bottom-up BGRA byte order: copy rows in reverse.
      uint8_t* targetRow = file.data() + offset
          + static_cast<size_t>(height - 1 - y) * rowBytes;
      std::memcpy(targetRow, sourceRow, rowBytes);
    }
    FILE* handle = nullptr;
    if (_wfopen_s(&handle, filePath.c_str(), L"wb") != 0 || handle == nullptr) {
      return false;
    }
    const size_t written = std::fwrite(file.data(), 1, file.size(), handle);
    std::fclose(handle);
    return written == file.size();
  }

  // Hardware-independent validation of the compose path: a synthetic half-SbS
  // frame is stretched into the 2W x H full-SbS texture and read back. This is
  // exactly the input the SR weaver consumes, and it is the only weave-path
  // code this project owns (the weave itself is SR-lib).
  bool SelfTest() {
    const uint32_t width = 640;
    const uint32_t height = 360;
    std::vector<uint8_t> pixels(static_cast<size_t>(width) * height * 4, 0);
    for (uint32_t y = 0; y < height; y += 1) {
      for (uint32_t x = 0; x < width; x += 1) {
        const size_t offset = (static_cast<size_t>(y) * width + x) * 4;
        const bool left = x < width / 2;
        pixels[offset + 0] = left ? 255 : 0;
        pixels[offset + 1] = 0;
        pixels[offset + 2] = left ? 0 : 255;
        pixels[offset + 3] = 255;
      }
    }
    const auto setWhiteMarker = [&](uint32_t x, uint32_t y) {
      for (uint32_t dy = 0; dy < 10; dy += 1) {
        for (uint32_t dx = 0; dx < 10; dx += 1) {
          const size_t offset =
              (static_cast<size_t>(y + dy) * width + (x + dx)) * 4;
          pixels[offset + 0] = 255;
          pixels[offset + 1] = 255;
          pixels[offset + 2] = 255;
        }
      }
    };
    setWhiteMarker(10, 10);
    setWhiteMarker(width / 2 + 10, 10);

    if (!EnsureTexture(width, height)) return false;
    for (uint32_t row = 0; row < height; row += 1) {
      std::memcpy(uploadMapped + static_cast<size_t>(row) * uploadRowPitch,
                  pixels.data() + static_cast<size_t>(row) * width * 4,
                  static_cast<size_t>(width) * 4);
    }
    if (!EnsureCompose(width, height)) return false;
    allocator->Reset();
    commandList->Reset(allocator, pipelineState);
    commandList->SetGraphicsRootSignature(rootSignature);
    D3D12_TEXTURE_COPY_LOCATION source = {};
    source.pResource = uploadBuffer;
    source.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
    source.PlacedFootprint.Footprint.Format = kFrameTextureFormat;
    source.PlacedFootprint.Footprint.Width = width;
    source.PlacedFootprint.Footprint.Height = height;
    source.PlacedFootprint.Footprint.Depth = 1;
    source.PlacedFootprint.Footprint.RowPitch = uploadRowPitch;
    D3D12_TEXTURE_COPY_LOCATION destination = {};
    destination.pResource = texture;
    destination.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
    commandList->CopyTextureRegion(&destination, 0, 0, 0, &source, nullptr);
    D3D12_RESOURCE_BARRIER barrier = {};
    barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    barrier.Transition.pResource = texture;
    barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_COPY_DEST;
    barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;
    commandList->ResourceBarrier(1, &barrier);
    ID3D12DescriptorHeap* heaps[] = {srvHeap};
    commandList->SetDescriptorHeaps(1, heaps);
    commandList->SetGraphicsRootDescriptorTable(
        0, srvHeap->GetGPUDescriptorHandleForHeapStart());
    commandList->IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    RecordStretchPass();
    commandList->Close();
    ID3D12CommandList* lists[] = {commandList};
    queue->ExecuteCommandLists(1, lists);
    WaitForGpu();

    std::vector<uint8_t> compose;
    uint32_t composeOutWidth = 0;
    uint32_t composeOutHeight = 0;
    if (!ReadbackResource(composeTexture,
                          D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE,
                          &compose, &composeOutWidth, &composeOutHeight)) {
      Log("SELF-TEST FAIL: compose readback failed");
      return false;
    }
    const auto sample = [&](uint32_t x, uint32_t y, int* r, int* g, int* b) {
      // The compose readback is B8G8R8A8 (weaver byte order).
      const size_t offset = (static_cast<size_t>(y) * composeOutWidth + x) * 4;
      *b = compose[offset + 0];
      *g = compose[offset + 1];
      *r = compose[offset + 2];
    };
    bool ok = true;
    const auto check = [&](bool condition, const char* label) {
      std::fprintf(stdout, "[BallanceLeiaPresenter] SELF-TEST %s: %s\n",
                   condition ? "PASS" : "FAIL", label);
      std::fflush(stdout);
      if (!condition) ok = false;
    };
    check(composeOutWidth == width * 2 && composeOutHeight == height,
          "compose dimensions are 2W x H");
    int r = 0, g = 0, b = 0;
    sample(5, 5, &r, &g, &b);
    check(r > 200 && g < 60 && b < 60, "left half samples the left eye");
    sample(composeOutWidth - 5, 5, &r, &g, &b);
    check(b > 200 && r < 60 && g < 60, "right half samples the right eye");
    sample(25, 15, &r, &g, &b);
    check(r > 200 && g > 200 && b > 200, "left marker stretched 2x horizontally");
    sample(width + 25, 15, &r, &g, &b);
    check(r > 200 && g > 200 && b > 200, "right marker stretched 2x horizontally");
    // Exercise the capture writer on the same readback when a capture dir is
    // given, so the checker covers WriteBmp without needing the transport
    // pipes (which may be owned by a live game session).
    if (!captureDir.empty()) {
      const std::wstring path = captureDir + L"\\selftest-compose.bmp";
      check(WriteBmp(path, compose, composeOutWidth, composeOutHeight),
            "compose readback written as BMP");
    }

    // Full-SBS input stage: the LeiaSR transport now carries two complete eye
    // frames (2W x H, e.g. 3840x1080 for a 1920x1080-per-eye panel). Verify
    // that input maps 1:1 into the same compose extent with no squeeze.
    {
      const uint32_t fullWidth = width * 2;
      std::vector<uint8_t> fullPixels(static_cast<size_t>(fullWidth) * height * 4, 0);
      for (uint32_t y = 0; y < height; y += 1) {
        for (uint32_t x = 0; x < fullWidth; x += 1) {
          const size_t offset = (static_cast<size_t>(y) * fullWidth + x) * 4;
          const bool left = x < fullWidth / 2;
          fullPixels[offset + 0] = left ? 255 : 0;
          fullPixels[offset + 1] = 0;
          fullPixels[offset + 2] = left ? 0 : 255;
          fullPixels[offset + 3] = 255;
        }
      }
      const auto setFullMarker = [&](uint32_t markerX, uint32_t markerY) {
        for (uint32_t dy = 0; dy < 10; dy += 1) {
          for (uint32_t dx = 0; dx < 10; dx += 1) {
            const size_t offset =
                (static_cast<size_t>(markerY + dy) * fullWidth + (markerX + dx)) * 4;
            fullPixels[offset + 0] = 255;
            fullPixels[offset + 1] = 255;
            fullPixels[offset + 2] = 255;
          }
        }
      };
      setFullMarker(20, 10);
      setFullMarker(fullWidth / 2 + 20, 10);
      if (!EnsureTexture(fullWidth, height)) return false;
      for (uint32_t row = 0; row < height; row += 1) {
        std::memcpy(uploadMapped + static_cast<size_t>(row) * uploadRowPitch,
                    fullPixels.data() + static_cast<size_t>(row) * fullWidth * 4,
                    static_cast<size_t>(fullWidth) * 4);
      }
      allocator->Reset();
      commandList->Reset(allocator, pipelineState);
      commandList->SetGraphicsRootSignature(rootSignature);
      D3D12_TEXTURE_COPY_LOCATION fullSource = {};
      fullSource.pResource = uploadBuffer;
      fullSource.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
      fullSource.PlacedFootprint.Footprint.Format = kFrameTextureFormat;
      fullSource.PlacedFootprint.Footprint.Width = fullWidth;
      fullSource.PlacedFootprint.Footprint.Height = height;
      fullSource.PlacedFootprint.Footprint.Depth = 1;
      fullSource.PlacedFootprint.Footprint.RowPitch = uploadRowPitch;
      D3D12_TEXTURE_COPY_LOCATION fullDestination = {};
      fullDestination.pResource = texture;
      fullDestination.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
      commandList->CopyTextureRegion(&fullDestination, 0, 0, 0, &fullSource, nullptr);
      D3D12_RESOURCE_BARRIER fullBarrier = {};
      fullBarrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
      fullBarrier.Transition.pResource = texture;
      fullBarrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
      fullBarrier.Transition.StateBefore = D3D12_RESOURCE_STATE_COPY_DEST;
      fullBarrier.Transition.StateAfter = D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;
      commandList->ResourceBarrier(1, &fullBarrier);
      ID3D12DescriptorHeap* fullHeaps[] = {srvHeap};
      commandList->SetDescriptorHeaps(1, fullHeaps);
      commandList->SetGraphicsRootDescriptorTable(
          0, srvHeap->GetGPUDescriptorHandleForHeapStart());
      commandList->IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
      RecordStretchPass();
      commandList->Close();
      ID3D12CommandList* fullLists[] = {commandList};
      queue->ExecuteCommandLists(1, fullLists);
      WaitForGpu();
      std::vector<uint8_t> fullCompose;
      uint32_t fullOutWidth = 0;
      uint32_t fullOutHeight = 0;
      if (!ReadbackResource(composeTexture,
                            D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE,
                            &fullCompose, &fullOutWidth, &fullOutHeight)) {
        check(false, "full-SBS input maps 1:1 into the compose");
      } else {
        const auto sampleFull = [&](uint32_t x, uint32_t y, int* sr, int* sg, int* sb) {
          const size_t offset = (static_cast<size_t>(y) * fullOutWidth + x) * 4;
          *sb = fullCompose[offset + 0];
          *sg = fullCompose[offset + 1];
          *sr = fullCompose[offset + 2];
        };
        int fr = 0, fg = 0, fb = 0;
        bool fullOk = fullOutWidth == fullWidth && fullOutHeight == height;
        sampleFull(5, 5, &fr, &fg, &fb);
        fullOk = fullOk && fr > 200 && fg < 60 && fb < 60;
        sampleFull(fullOutWidth - 5, 5, &fr, &fg, &fb);
        fullOk = fullOk && fb > 200 && fr < 60 && fg < 60;
        sampleFull(25, 15, &fr, &fg, &fb);
        fullOk = fullOk && fr > 200 && fg > 200 && fb > 200;
        sampleFull(fullWidth / 2 + 25, 15, &fr, &fg, &fb);
        fullOk = fullOk && fr > 200 && fg > 200 && fb > 200;
        check(fullOk, "full-SBS input maps 1:1 into the compose");
      }
    }

    // Second stage: the app-owned weave output path. Clear the weave texture,
    // blit it to the back buffer through the same pass used for presentation,
    // and read the back buffer back. This is the surface the SDK weaves into on
    // hardware and the exact pixels --capture-dir reads, so the BGRA weave
    // target, the weave SRV binding and the present blit are all exercised
    // without SR hardware.
    if (!EnsureWeaveTexture(width, height)) {
      check(false, "weave output blitted to the back buffer");
      return ok;
    }
    allocator->Reset();
    commandList->Reset(allocator, pipelineState);
    commandList->SetGraphicsRootSignature(rootSignature);
    ID3D12DescriptorHeap* heaps2[] = {srvHeap};
    commandList->SetDescriptorHeaps(1, heaps2);
    const float green[4] = {0.0f, 1.0f, 0.0f, 1.0f};
    D3D12_CPU_DESCRIPTOR_HANDLE weaveRtv = WeaveRtv();
    commandList->OMSetRenderTargets(1, &weaveRtv, FALSE, nullptr);
    commandList->ClearRenderTargetView(weaveRtv, green, 0, nullptr);
    D3D12_RESOURCE_BARRIER weaveToRead = {};
    weaveToRead.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    weaveToRead.Transition.pResource = weaveTexture;
    weaveToRead.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    weaveToRead.Transition.StateBefore = D3D12_RESOURCE_STATE_RENDER_TARGET;
    weaveToRead.Transition.StateAfter = D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;
    commandList->ResourceBarrier(1, &weaveToRead);
    weaveIsRenderTarget = false;

    RECT client = {};
    GetClientRect(hwnd, &client);
    const uint32_t swapWidth = static_cast<uint32_t>(client.right - client.left);
    const uint32_t swapHeight = static_cast<uint32_t>(client.bottom - client.top);
    const UINT backBufferIndex = swapChain->GetCurrentBackBufferIndex();
    D3D12_CPU_DESCRIPTOR_HANDLE backBufferRtv =
        rtvHeap->GetCPUDescriptorHandleForHeapStart();
    backBufferRtv.ptr += static_cast<SIZE_T>(backBufferIndex) * rtvDescriptorSize;
    D3D12_RESOURCE_BARRIER toRenderTarget = {};
    toRenderTarget.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    toRenderTarget.Transition.pResource = renderTargets[backBufferIndex];
    toRenderTarget.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    toRenderTarget.Transition.StateBefore = D3D12_RESOURCE_STATE_PRESENT;
    toRenderTarget.Transition.StateAfter = D3D12_RESOURCE_STATE_RENDER_TARGET;
    commandList->ResourceBarrier(1, &toRenderTarget);
    const float black[4] = {0.0f, 0.0f, 0.0f, 1.0f};
    commandList->OMSetRenderTargets(1, &backBufferRtv, FALSE, nullptr);
    commandList->ClearRenderTargetView(backBufferRtv, black, 0, nullptr);
    D3D12_VIEWPORT viewport = {0.0f, 0.0f, static_cast<float>(swapWidth),
                               static_cast<float>(swapHeight), 0.0f, 1.0f};
    D3D12_RECT scissor = {0, 0, static_cast<LONG>(swapWidth),
                          static_cast<LONG>(swapHeight)};
    commandList->RSSetViewports(1, &viewport);
    commandList->RSSetScissorRects(1, &scissor);
    commandList->SetGraphicsRootDescriptorTable(0, WeaveSrv());
    commandList->IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    commandList->SetPipelineState(pipelineState);
    commandList->DrawInstanced(3, 1, 0, 0);
    D3D12_RESOURCE_BARRIER toPresent = toRenderTarget;
    toPresent.Transition.StateBefore = D3D12_RESOURCE_STATE_RENDER_TARGET;
    toPresent.Transition.StateAfter = D3D12_RESOURCE_STATE_PRESENT;
    commandList->ResourceBarrier(1, &toPresent);
    commandList->Close();
    ID3D12CommandList* lists2[] = {commandList};
    queue->ExecuteCommandLists(1, lists2);
    WaitForGpu();

    std::vector<uint8_t> presented;
    uint32_t presentedOutWidth = 0;
    uint32_t presentedOutHeight = 0;
    if (!ReadbackResource(renderTargets[backBufferIndex],
                          D3D12_RESOURCE_STATE_PRESENT, &presented,
                          &presentedOutWidth, &presentedOutHeight)) {
      check(false, "weave output blitted to the back buffer");
      return ok;
    }
    const size_t centerOffset =
        (static_cast<size_t>(presentedOutHeight / 2) * presentedOutWidth +
         presentedOutWidth / 2) * 4;
    const int centerB = presented[centerOffset + 0];
    const int centerG = presented[centerOffset + 1];
    const int centerR = presented[centerOffset + 2];
    check(centerG > 200 && centerR < 60 && centerB < 60,
          "weave output blitted to the back buffer");
    return ok;
  }

  // Blits a full-screen source SRV to the current back buffer and leaves the
  // buffer in RENDER_TARGET (the caller transitions it to PRESENT). The root
  // signature, descriptor heap and pipeline are re-set here because the SDK
  // weave may have changed command-list state behind our back, and a failed
  // weave falls into this same path.
  void RecordPresentBlit(uint32_t backBufferIndex,
                         D3D12_GPU_DESCRIPTOR_HANDLE sourceSrv) {
    RECT client = {};
    GetClientRect(hwnd, &client);
    const uint32_t swapWidth = static_cast<uint32_t>(client.right - client.left);
    const uint32_t swapHeight = static_cast<uint32_t>(client.bottom - client.top);
    D3D12_CPU_DESCRIPTOR_HANDLE backBufferRtv =
        rtvHeap->GetCPUDescriptorHandleForHeapStart();
    backBufferRtv.ptr += static_cast<SIZE_T>(backBufferIndex) * rtvDescriptorSize;
    D3D12_RESOURCE_BARRIER toRenderTarget = {};
    toRenderTarget.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    toRenderTarget.Transition.pResource = renderTargets[backBufferIndex];
    toRenderTarget.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    toRenderTarget.Transition.StateBefore = D3D12_RESOURCE_STATE_PRESENT;
    toRenderTarget.Transition.StateAfter = D3D12_RESOURCE_STATE_RENDER_TARGET;
    commandList->ResourceBarrier(1, &toRenderTarget);
    const float clear[4] = {0.0f, 0.0f, 0.0f, 1.0f};
    commandList->OMSetRenderTargets(1, &backBufferRtv, FALSE, nullptr);
    commandList->ClearRenderTargetView(backBufferRtv, clear, 0, nullptr);
    D3D12_VIEWPORT viewport = {
        0.0f, 0.0f, static_cast<float>(swapWidth),
        static_cast<float>(swapHeight), 0.0f, 1.0f};
    D3D12_RECT scissor = {
        0, 0, static_cast<LONG>(swapWidth), static_cast<LONG>(swapHeight)};
    commandList->RSSetViewports(1, &viewport);
    commandList->RSSetScissorRects(1, &scissor);
    commandList->SetGraphicsRootSignature(rootSignature);
    ID3D12DescriptorHeap* heaps[] = {srvHeap};
    commandList->SetDescriptorHeaps(1, heaps);
    commandList->SetGraphicsRootDescriptorTable(0, sourceSrv);
    commandList->IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    commandList->SetPipelineState(pipelineState);
    commandList->DrawInstanced(3, 1, 0, 0);
  }

  bool UploadAndPresent(const std::vector<uint8_t>& pixels, uint32_t width,
                        uint32_t height) {
    if (!EnsureTexture(width, height)) return false;
    for (uint32_t row = 0; row < height; ++row) {
      std::memcpy(uploadMapped + static_cast<size_t>(row) * uploadRowPitch,
                  pixels.data() + static_cast<size_t>(row) * width * 4,
                  static_cast<size_t>(width) * 4);
    }

    HRESULT hrReset = allocator->Reset();
    if (FAILED(hrReset)) {
      LogHr("allocator reset", hrReset);
      return false;
    }
    hrReset = commandList->Reset(allocator, pipelineState);
    if (FAILED(hrReset)) {
      LogHr("command list reset", hrReset);
      return false;
    }
    // The root signature must be set explicitly after Reset: binding the PSO
    // alone is not enough on every driver and SetGraphicsRootDescriptorTable
    // faults without it.
    commandList->SetGraphicsRootSignature(rootSignature);

    D3D12_TEXTURE_COPY_LOCATION source = {};
    source.pResource = uploadBuffer;
    source.Type = D3D12_TEXTURE_COPY_TYPE_PLACED_FOOTPRINT;
    source.PlacedFootprint.Footprint.Format = kFrameTextureFormat;
    source.PlacedFootprint.Footprint.Width = width;
    source.PlacedFootprint.Footprint.Height = height;
    source.PlacedFootprint.Footprint.Depth = 1;
    source.PlacedFootprint.Footprint.RowPitch = uploadRowPitch;
    D3D12_TEXTURE_COPY_LOCATION destination = {};
    destination.pResource = texture;
    destination.Type = D3D12_TEXTURE_COPY_TYPE_SUBRESOURCE_INDEX;
    destination.SubresourceIndex = 0;
    commandList->CopyTextureRegion(&destination, 0, 0, 0, &source, nullptr);

    D3D12_RESOURCE_BARRIER barrier = {};
    barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    barrier.Transition.pResource = texture;
    barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_COPY_DEST;
    barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;
    commandList->ResourceBarrier(1, &barrier);

    return PresentInput(srvHeap->GetGPUDescriptorHandleForHeapStart(), width,
                        height);
  }

  /**
   * Electron renders into a D3D12 shared texture; duplicate its NT handle from
   * the Electron main process into this one and sample it directly (no CPU
   * readback, no 16 MB pipe payload). The texture is released by the main
   * process only after this frame's ack, and the opened resource stays alive
   * until the GPU work has completed.
   */
  bool PresentSharedTexture(const SharedTextureFrame& frame, uint32_t width,
                            uint32_t height) {
    // Test hook: BALLANCE_LEIA_REJECT_SHARED_TEXTURE=1 exercises the main
    // process's CPU-bitmap fallback without a second GPU adapter.
    if (GetEnvironmentVariableW(L"BALLANCE_LEIA_REJECT_SHARED_TEXTURE", nullptr,
                                0) > 0) {
      Log("shared texture rejected by BALLANCE_LEIA_REJECT_SHARED_TEXTURE");
      return false;
    }
    DXGI_FORMAT format = DXGI_FORMAT_UNKNOWN;
    if (frame.pixelFormat == kSharedPixelBgra8) {
      format = DXGI_FORMAT_B8G8R8A8_UNORM;
    } else if (frame.pixelFormat == kSharedPixelRgba8) {
      format = DXGI_FORMAT_R8G8B8A8_UNORM;
    } else {
      Log("unsupported shared texture pixel format");
      return false;
    }

    HANDLE sourceProcess =
        OpenProcess(PROCESS_DUP_HANDLE, FALSE, frame.sourcePid);
    if (sourceProcess == nullptr) {
      LogHr("OpenProcess shared texture", HRESULT_FROM_WIN32(GetLastError()));
      return false;
    }
    HANDLE duplicated = nullptr;
    const HANDLE remote =
        reinterpret_cast<HANDLE>(static_cast<uintptr_t>(frame.handle));
    const BOOL duplicatedOk =
        DuplicateHandle(sourceProcess, remote, GetCurrentProcess(), &duplicated,
                        0, FALSE, DUPLICATE_SAME_ACCESS);
    CloseHandle(sourceProcess);
    if (!duplicatedOk) {
      LogHr("DuplicateHandle shared texture", HRESULT_FROM_WIN32(GetLastError()));
      return false;
    }
    ID3D12Resource* shared = nullptr;
    HRESULT hr = device->OpenSharedHandle(duplicated, IID_PPV_ARGS(&shared));
    CloseHandle(duplicated);
    if (FAILED(hr) || shared == nullptr) {
      LogHr("OpenSharedHandle", hr);
      return false;
    }
    const D3D12_RESOURCE_DESC desc = shared->GetDesc();
    if (desc.Dimension != D3D12_RESOURCE_DIMENSION_TEXTURE2D ||
        desc.Width != width || desc.Height != height) {
      Log("shared texture dimensions do not match the frame");
      shared->Release();
      return false;
    }

    D3D12_SHADER_RESOURCE_VIEW_DESC srvDesc = {};
    srvDesc.Format = format;
    srvDesc.ViewDimension = D3D12_SRV_DIMENSION_TEXTURE2D;
    srvDesc.Shader4ComponentMapping = D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
    srvDesc.Texture2D.MipLevels = 1;
    device->CreateShaderResourceView(shared, &srvDesc, SharedSrvCpu());
    if ((frame.flags & kSharedProbe) != 0) {
      shared->Release();
      return true;
    }

    hr = allocator->Reset();
    if (FAILED(hr)) {
      LogHr("allocator reset (shared texture)", hr);
      shared->Release();
      return false;
    }
    hr = commandList->Reset(allocator, pipelineState);
    if (FAILED(hr)) {
      LogHr("command list reset (shared texture)", hr);
      shared->Release();
      return false;
    }
    commandList->SetGraphicsRootSignature(rootSignature);
    D3D12_RESOURCE_BARRIER barrier = {};
    barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    barrier.Transition.pResource = shared;
    barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_COMMON;
    barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;
    commandList->ResourceBarrier(1, &barrier);

    const bool presented = PresentInput(SharedSrvGpu(), width, height);
    shared->Release();
    return presented;
  }

  // Presents a full-size input already in PIXEL_SHADER_RESOURCE state. The
  // caller has uploaded the pixels or opened Electron's shared texture and
  // created its SRV; `inputSrv` is the one to stretch/present.
  bool PresentInput(D3D12_GPU_DESCRIPTOR_HANDLE inputSrv, uint32_t width,
                    uint32_t height) {
    (void)width;
    (void)height;
    RECT client = {};
    GetClientRect(hwnd, &client);
    const uint32_t swapWidth = static_cast<uint32_t>(client.right - client.left);
    const uint32_t swapHeight = static_cast<uint32_t>(client.bottom - client.top);
    const UINT backBufferIndex = swapChain->GetCurrentBackBufferIndex();
    ID3D12DescriptorHeap* heaps[] = {srvHeap};
    commandList->SetDescriptorHeaps(1, heaps);
    commandList->SetGraphicsRootDescriptorTable(0, inputSrv);
    commandList->IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);

    bool useWeave = false;
#if defined(BALLANCE_LEIA_SR)
    useWeave = srInterface != nullptr && EnsureCompose(swapWidth, swapHeight)
        && EnsureWeaveTexture(swapWidth, swapHeight);
#endif
    // One plain frame after the weave target is (re)created so the panel/swap
    // chain settles before the first weave into the new surface.
    bool weaveThisFrame = useWeave && weaveSettled;
    if (useWeave && !weaveSettled) weaveSettled = true;
    const bool captureFrame =
        !captureDir.empty() && captureFramesRemaining > 0;
    // Capture mode records the full-SbS compose even when the SR runtime is
    // absent or the weave is settling, so the remote-evidence pair (presented +
    // weaver input) is complete on any machine.
    if (!weaveThisFrame && captureFrame && EnsureCompose(swapWidth, swapHeight)) {
      RecordStretchPass();
    }
    bool presentWoven = false;
    bool weaveFailed = false;
    if (weaveThisFrame) {
#if defined(BALLANCE_LEIA_SR)
      // 1) Stretch the received half-SbS frame into the full-SbS compose
      //    texture the weaver consumes (L in the left half, R in the right).
      RecordStretchPass();

      // 2) Weave into the app-owned panel-extent texture, never into a
      //    swap-chain buffer: an SR display-mode switch invalidates the swap
      //    chain (black frames, RAM growth, device removal). The command
      //    list's own rasterizer viewport must be the weave extent: D3D12
      //    rasterizes against RSSetViewports, not the weaver's setViewport.
      bool wove = false;
      try {
        if (!weaveIsRenderTarget) {
          D3D12_RESOURCE_BARRIER toWeaveTarget = {};
          toWeaveTarget.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
          toWeaveTarget.Transition.pResource = weaveTexture;
          toWeaveTarget.Transition.Subresource =
              D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
          toWeaveTarget.Transition.StateBefore =
              D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;
          toWeaveTarget.Transition.StateAfter =
              D3D12_RESOURCE_STATE_RENDER_TARGET;
          commandList->ResourceBarrier(1, &toWeaveTarget);
          weaveIsRenderTarget = true;
        }
        D3D12_CPU_DESCRIPTOR_HANDLE weaveRtv = WeaveRtv();
        commandList->OMSetRenderTargets(1, &weaveRtv, FALSE, nullptr);
        const float clear[4] = {0.0f, 0.0f, 0.0f, 1.0f};
        commandList->ClearRenderTargetView(weaveRtv, clear, 0, nullptr);
        D3D12_VIEWPORT weaveViewport = {
            0.0f, 0.0f, static_cast<float>(weaveWidth),
            static_cast<float>(weaveHeight), 0.0f, 1.0f};
        D3D12_RECT weaveScissor = {
            0, 0, static_cast<LONG>(weaveWidth), static_cast<LONG>(weaveHeight)};
        commandList->RSSetViewports(1, &weaveViewport);
        commandList->RSSetScissorRects(1, &weaveScissor);
        srInterface->SetInputTexture(composeTexture);
        if (srOutputFormat != kSwapChainFormat) {
          srInterface->SetOutputFormat(kSwapChainFormat);
          srOutputFormat = kSwapChainFormat;
        }
        srInterface->Weave(commandList, weaveViewport, weaveScissor);
        SimulatedReality::SREnableLensHint();
        wove = true;
      } catch (const std::exception& error) {
        std::fprintf(stdout, "[BallanceLeiaPresenter] weave threw: %s\n",
                     error.what());
        std::fflush(stdout);
      }
      if (wove) {
        D3D12_RESOURCE_BARRIER weaveToRead = {};
        weaveToRead.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
        weaveToRead.Transition.pResource = weaveTexture;
        weaveToRead.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
        weaveToRead.Transition.StateBefore = D3D12_RESOURCE_STATE_RENDER_TARGET;
        weaveToRead.Transition.StateAfter = D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;
        commandList->ResourceBarrier(1, &weaveToRead);
        weaveIsRenderTarget = false;
        presentWoven = true;
      } else {
        // A failed weave must not blank the window: present the plain
        // side-by-side frame in this same command list and latch the weaver
        // off after submission (the SDK teardown can block).
        Log("weave failed; falling back to plain side-by-side");
        weaveFailed = true;
      }
#endif
    }
    if (presentWoven) {
      // Present the woven texture through the normal blit.
      RecordPresentBlit(backBufferIndex, WeaveSrv());
    } else {
      // Plain side-by-side: the no-runtime fallback, the weave-settle frame and
      // the post-weave-failure frame all present the received frame directly.
      RecordPresentBlit(backBufferIndex, inputSrv);
    }

    D3D12_RESOURCE_BARRIER toPresent = {};
    toPresent.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
    toPresent.Transition.pResource = renderTargets[backBufferIndex];
    toPresent.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
    toPresent.Transition.StateBefore = D3D12_RESOURCE_STATE_RENDER_TARGET;
    toPresent.Transition.StateAfter = D3D12_RESOURCE_STATE_PRESENT;
    commandList->ResourceBarrier(1, &toPresent);

    commandList->Close();
    ID3D12CommandList* lists[] = {commandList};
    queue->ExecuteCommandLists(1, lists);
    if (weaveFailed) {
      // Teardown after submission: Delete() can block on the SDK, and the
      // fallback frame must already be on the queue.
      DisableSr();
    }
    // Evidence capture must run against the buffer that is about to be
    // presented: after Present, GetCurrentBackBufferIndex returns the next
    // render target, not the displayed one, so a post-Present readback would
    // capture the previous frame (or an uninitialized buffer on the first
    // capture).
    if (captureFrame) {
      WaitForGpu();
      CapturePresentedFrame();
      captureFramesRemaining -= 1;
    }
    HRESULT hr = swapChain->Present(1, 0);
    if (FAILED(hr)) {
      LogHr("Present", hr);
      CheckDeviceRemoved();
      return false;
    }
    WaitForGpu();
    return true;
  }

  // Remote hardware-evidence capture. Called after the frame's command list
  // completes and before Present, so the current back buffer holds exactly the
  // pixels about to be displayed (post-weave when SR is active); the compose
  // texture holds the full-SbS input the weaver consumed.
  void CapturePresentedFrame() {
    const uint32_t index = swapChain->GetCurrentBackBufferIndex();
    std::vector<uint8_t> presented;
    uint32_t presentedWidth = 0;
    uint32_t presentedHeight = 0;
    if (ReadbackResource(renderTargets[index], D3D12_RESOURCE_STATE_PRESENT,
                         &presented, &presentedWidth, &presentedHeight)) {
      const std::wstring path = captureDir + L"\\presented.bmp";
      if (WriteBmp(path, presented, presentedWidth, presentedHeight)) {
        std::fprintf(stdout, "[BallanceLeiaPresenter] captured %ls (%ux%u)\n",
                     path.c_str(), presentedWidth, presentedHeight);
        std::fflush(stdout);
      }
    }
    if (composeTexture) {
      std::vector<uint8_t> compose;
      uint32_t composeOutWidth = 0;
      uint32_t composeOutHeight = 0;
      if (ReadbackResource(composeTexture,
                           D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE,
                           &compose, &composeOutWidth, &composeOutHeight)) {
        const std::wstring path = captureDir + L"\\compose.bmp";
        if (WriteBmp(path, compose, composeOutWidth, composeOutHeight)) {
          std::fprintf(stdout, "[BallanceLeiaPresenter] captured %ls (%ux%u)\n",
                       path.c_str(), composeOutWidth, composeOutHeight);
          std::fflush(stdout);
        }
      }
    }
  }

  // An SR display-mode switch can invalidate the device/swap chain. The helper
  // cannot recreate its own device cheaply; it exits and the Electron transport
  // restarts it with a fresh one (the transport retries up to three times).
  void CheckDeviceRemoved() {
    if (deviceLost || !device) return;
    const HRESULT reason = device->GetDeviceRemovedReason();
    if (FAILED(reason)) {
      std::fprintf(stdout,
                   "[BallanceLeiaPresenter] device removed (hr 0x%08lx); exiting for restart\n",
                   static_cast<unsigned long>(reason));
      std::fflush(stdout);
      deviceLost = true;
    }
  }

  void WaitForGpu() {
    const uint64_t value = ++fenceValue;
    queue->Signal(fence, value);
    if (fence->GetCompletedValue() < value) {
      fence->SetEventOnCompletion(value, fenceEvent);
      WaitForSingleObject(fenceEvent, 2000);
      if (fence->GetCompletedValue() < value) CheckDeviceRemoved();
    }
  }

  void DumpDebugMessages() {
    ID3D12InfoQueue* infoQueue = nullptr;
    if (FAILED(device->QueryInterface(IID_PPV_ARGS(&infoQueue)))) return;
    const UINT64 count = infoQueue->GetNumStoredMessages();
    for (UINT64 index = 0; index < count; index += 1) {
      SIZE_T size = 0;
      infoQueue->GetMessage(index, nullptr, &size);
      if (size == 0) continue;
      std::vector<char> buffer(size);
      D3D12_MESSAGE* message = reinterpret_cast<D3D12_MESSAGE*>(buffer.data());
      if (SUCCEEDED(infoQueue->GetMessage(index, message, &size))) {
        std::fprintf(stdout, "[BallanceLeiaPresenter] debug: %s\n",
                     message->pDescription ? message->pDescription : "(null)");
      }
    }
    std::fflush(stdout);
    infoQueue->Release();
  }

  void Resize(uint32_t width, uint32_t height) {
    if (!swapChain || width == 0 || height == 0) return;
    WaitForGpu();
    ReleaseRenderTargets();
    // The window is WS_POPUP (no frame), so its client area always equals its
    // window area. Resizing only the swap chain would leave GetClientRect
    // reporting the old size and the viewport would no longer match the render
    // target (cropped, zoomed presentation).
    SetWindowPos(hwnd, nullptr, 0, 0, static_cast<int>(width),
                 static_cast<int>(height),
                 SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
    HRESULT hr = swapChain->ResizeBuffers(kSwapChainBufferCount, width, height,
                                          kSwapChainFormat, 0);
    if (FAILED(hr)) {
      LogHr("ResizeBuffers", hr);
      return;
    }
    CreateRenderTargets();
    Log("swapchain resized");
  }

  // The SR panel owner's window: borderless on the selected monitor so the
  // weave lands 1:1 on physical panel pixels. Applied only when the SR runtime
  // actually initialized; the plain fallback stays a windowed 1280x720.
  //
  // The weave extent follows the panel's CURRENT display mode, not the
  // monitor's native rectangle: the SR runtime switches the panel to its weave
  // mode (the Acer SpatialLabs 27 weaves 1920x1080 per eye, so the presenter
  // must output 1920x1080 and consume a 3840x1080 full-SBS input). An explicit
  // --weave-size WxH override is available for panel owners when the mode is
  // not switched automatically.
  void SetFullscreenOnMonitor(int monitorIndex) {
    RECT rect = {};
    if (!MonitorRectForIndex(monitorIndex, &rect)) return;
    uint32_t width = static_cast<uint32_t>(rect.right - rect.left);
    uint32_t height = static_cast<uint32_t>(rect.bottom - rect.top);
    if (weaveSizeOverrideWidth > 0 && weaveSizeOverrideHeight > 0) {
      width = weaveSizeOverrideWidth;
      height = weaveSizeOverrideHeight;
      std::fprintf(stdout,
                   "[BallanceLeiaPresenter] weave output %ux%u (--weave-size override)\n",
                   width, height);
    } else {
      wchar_t deviceName[32] = {};
      if (MonitorDeviceForIndex(monitorIndex, deviceName)) {
        DEVMODEW mode = {};
        mode.dmSize = sizeof(mode);
        if (EnumDisplaySettingsW(deviceName, ENUM_CURRENT_SETTINGS, &mode)
            && mode.dmPelsWidth > 0 && mode.dmPelsHeight > 0) {
          width = mode.dmPelsWidth;
          height = mode.dmPelsHeight;
        }
      }
      std::fprintf(stdout,
                   "[BallanceLeiaPresenter] weave output %ux%u (current display mode)\n",
                   width, height);
    }
    std::fflush(stdout);
    fullscreenOnMonitor = true;
    SetWindowPos(hwnd, HWND_TOP, rect.left, rect.top,
                 static_cast<int>(width), static_cast<int>(height),
                 SWP_SHOWWINDOW);
    Resize(width, height);
    ActivatePresenterWindow(hwnd);
  }

  bool IsFullscreenOnMonitor() const { return fullscreenOnMonitor; }

  // Panel-owner override for the weave/output extent (0 = auto-detect).
  uint32_t weaveSizeOverrideWidth = 0;
  uint32_t weaveSizeOverrideHeight = 0;

  void Shutdown() {
    WaitForGpu();
    ShutdownSr();
    ReleaseTexture();
    ReleaseCompose();
    ReleaseWeaveTexture();
    ReleaseRenderTargets();
    if (stretchPipelineState) stretchPipelineState->Release();
    if (fenceEvent) CloseHandle(fenceEvent);
    if (fence) fence->Release();
    if (pipelineState) pipelineState->Release();
    if (commandList) commandList->Release();
    if (allocator) allocator->Release();
    if (rootSignature) rootSignature->Release();
    if (srvHeap) srvHeap->Release();
    if (rtvHeap) rtvHeap->Release();
    if (swapChain) swapChain->Release();
    if (queue) queue->Release();
    if (device) device->Release();
    if (factory) factory->Release();
  }
};

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

PipeThreads* gPipes = nullptr;
bool gClosedByUser = false;

// The SR runtime engages the lens for the foreground window. Show, activate
// and focus the presenter so starting it and clicking it both bring it to the
// front (the original WS_EX_NOACTIVATE window never became the active window,
// which is the suspected cause of the lens engaging and dropping back).
void ActivatePresenterWindow(HWND hwnd) {
  if (!hwnd) return;
  if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE);
  ShowWindow(hwnd, SW_SHOW);
  BringWindowToTop(hwnd);
  SetForegroundWindow(hwnd);
  SetActiveWindow(hwnd);
  SetFocus(hwnd);
}

LRESULT CALLBACK WindowProc(HWND hwnd, UINT message, WPARAM wParam,
                            LPARAM lParam) {
  switch (message) {
    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;
    case WM_CLOSE:
      // Exit code 3 tells the Electron transport this was the user closing
      // the presenter (Alt+F4), so it returns to normal mode instead of
      // restarting the helper.
      gClosedByUser = true;
      DestroyWindow(hwnd);
      return 0;
    case WM_LBUTTONDOWN:
      ActivatePresenterWindow(hwnd);
      return 0;
    case WM_KEYDOWN:
    case WM_KEYUP:
    case WM_SYSKEYDOWN:
    case WM_SYSKEYUP:
      if (gPipes) gPipes->SendKey(message, wParam, lParam);
      // Alt+F4 and other system keys still go through DefWindowProc.
      return DefWindowProcW(hwnd, message, wParam, lParam);
    default:
      return DefWindowProcW(hwnd, message, wParam, lParam);
  }
}

struct MonitorSearch {
  int target;
  int index;
  RECT rect;
  wchar_t deviceName[32];
  bool found;
};

BOOL CALLBACK FindMonitorProc(HMONITOR monitor, HDC, LPRECT, LPARAM data) {
  MonitorSearch* search = reinterpret_cast<MonitorSearch*>(data);
  if (search->index == search->target) {
    MONITORINFOEXW info = {};
    info.cbSize = sizeof(info);
    if (GetMonitorInfoW(monitor, &info)) {
      search->rect = info.rcMonitor;
      wcsncpy_s(search->deviceName, info.szDevice, _TRUNCATE);
      search->found = true;
    }
    return FALSE;
  }
  search->index += 1;
  return TRUE;
}

bool MonitorRectForIndex(int index, RECT* rect) {
  MonitorSearch search = {index, 0, {}, {}, false};
  EnumDisplayMonitors(nullptr, nullptr, FindMonitorProc,
                      reinterpret_cast<LPARAM>(&search));
  if (!search.found) return false;
  *rect = search.rect;
  return true;
}

bool MonitorDeviceForIndex(int index, wchar_t deviceName[32]) {
  MonitorSearch search = {index, 0, {}, {}, false};
  EnumDisplayMonitors(nullptr, nullptr, FindMonitorProc,
                      reinterpret_cast<LPARAM>(&search));
  if (!search.found) return false;
  wcsncpy_s(deviceName, 32, search.deviceName, _TRUNCATE);
  return true;
}

HWND CreatePresenterWindow(bool offscreen, int monitorIndex) {
  WNDCLASSEXW windowClass = {};
  windowClass.cbSize = sizeof(windowClass);
  windowClass.style = CS_HREDRAW | CS_VREDRAW;
  windowClass.lpfnWndProc = WindowProc;
  windowClass.hInstance = GetModuleHandleW(nullptr);
  windowClass.hCursor = LoadCursorW(nullptr, reinterpret_cast<LPCWSTR>(IDC_ARROW));
  windowClass.lpszClassName = L"BallanceLeiaPresenterWindow";
  RegisterClassExW(&windowClass);

  RECT monitorRect = {0, 0, GetSystemMetrics(SM_CXSCREEN),
                      GetSystemMetrics(SM_CYSCREEN)};
  MonitorRectForIndex(monitorIndex, &monitorRect);
  const int monitorWidth = monitorRect.right - monitorRect.left;
  const int monitorHeight = monitorRect.bottom - monitorRect.top;
  const int width = monitorWidth < 1280 ? monitorWidth : 1280;
  const int height = monitorHeight < 720 ? monitorHeight : 720;
  const int x = offscreen ? -20000 : monitorRect.left + (monitorWidth - width) / 2;
  const int y = offscreen ? -20000 : monitorRect.top + (monitorHeight - height) / 2;
  // A normal, activatable top-level window: no WS_EX_NOACTIVATE/TOOLWINDOW.
  HWND hwnd = CreateWindowExW(
      0, L"BallanceLeiaPresenterWindow",
      L"Ballance LeiaSR Presenter", WS_POPUP,
      x, y, width, height,
      nullptr, nullptr, GetModuleHandleW(nullptr), nullptr);
  if (hwnd) {
    if (offscreen) {
      ShowWindow(hwnd, SW_SHOWNOACTIVATE);
      UpdateWindow(hwnd);
    } else {
      ActivatePresenterWindow(hwnd);
      UpdateWindow(hwnd);
    }
  }
  return hwnd;
}

}  // namespace

int APIENTRY wWinMain(HINSTANCE, HINSTANCE, LPWSTR commandLine, int) {
  const std::wstring arguments = commandLine != nullptr ? commandLine : L"";
  const bool offscreen = arguments.find(L"--offscreen") != std::wstring::npos;
  const bool windowed = arguments.find(L"--windowed") != std::wstring::npos;
  const bool selfTest = arguments.find(L"--self-test") != std::wstring::npos;
  int monitorIndex = 0;
  const size_t monitorPosition = arguments.find(L"--monitor ");
  if (monitorPosition != std::wstring::npos) {
    monitorIndex = _wtoi(arguments.c_str() + monitorPosition + 10);
  }
  std::wstring captureDir;
  const size_t capturePosition = arguments.find(L"--capture-dir ");
  if (capturePosition != std::wstring::npos) {
    std::wstring remainder = arguments.substr(capturePosition + 14);
    if (!remainder.empty() && remainder[0] == L'"') {
      remainder = remainder.substr(1, remainder.find(L'"', 1) - 1);
    } else {
      const size_t end = remainder.find(L' ');
      if (end != std::wstring::npos) remainder = remainder.substr(0, end);
    }
    captureDir = remainder;
  }
  uint32_t captureFrames = 1;
  const size_t framesPosition = arguments.find(L"--capture-frames ");
  if (framesPosition != std::wstring::npos) {
    captureFrames = static_cast<uint32_t>(
        _wtoi(arguments.c_str() + framesPosition + 17));
  }
  uint32_t weaveSizeWidth = 0;
  uint32_t weaveSizeHeight = 0;
  const size_t weaveSizePosition = arguments.find(L"--weave-size ");
  if (weaveSizePosition != std::wstring::npos) {
    const wchar_t* text = arguments.c_str() + weaveSizePosition + 13;
    weaveSizeWidth = static_cast<uint32_t>(_wtoi(text));
    const wchar_t* separator = wcschr(text, L'x');
    if (separator != nullptr) {
      weaveSizeHeight = static_cast<uint32_t>(_wtoi(separator + 1));
    }
  }
  // Per-monitor DPI awareness v2 before any window is created so the weave can
  // land 1:1 on physical panel pixels in step 3.
  if (!SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) {
    SetProcessDPIAware();
  }
  // Main reads this before creating the offscreen window and picks the
  // shared-texture or CPU-bitmap paint mode from it.
  Log("protocol=2 shared-texture=1");

  PipeThreads pipes;
  gPipes = &pipes;

  HWND hwnd = CreatePresenterWindow(offscreen, monitorIndex);
  if (!hwnd) {
    Log("window creation failed");
    return 1;
  }

  Presenter presenter;
  if (!presenter.Initialize(hwnd)) {
    Log("DX12 initialization failed");
    DestroyWindow(hwnd);
    return 1;
  }
  presenter.weaveSizeOverrideWidth = weaveSizeWidth;
  presenter.weaveSizeOverrideHeight = weaveSizeHeight;
  // Borderless fullscreen on the chosen monitor (the fallback included) so the
  // focused presenter owns the panel; --windowed keeps the 1280x720 window and
  // --offscreen parks it outside the desktop for headless tests.
  if (!windowed && !offscreen) {
    presenter.SetFullscreenOnMonitor(monitorIndex);
  } else if (!offscreen) {
    ActivatePresenterWindow(hwnd);
  }
  Log("presenter ready");

  presenter.captureDir = captureDir;
  presenter.captureFramesRemaining = captureFrames;

  // Self-test mode must not start the transport pipes: ConnectPipeWithRetry
  // blocks until a pipe server exists, so a bare `--self-test` run would hang
  // forever before reporting anything.
  if (selfTest) {
    const bool passed = presenter.SelfTest();
    std::fprintf(stdout, "[BallanceLeiaPresenter] SELF-TEST RESULT: %s\n",
                 passed ? "PASS" : "FAIL");
    std::fflush(stdout);
    presenter.Shutdown();
    DestroyWindow(hwnd);
    return passed ? 0 : 1;
  }

  pipes.Start();

  std::vector<uint8_t> framePixels;
  MSG message = {};
  bool running = true;
  while (running) {
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
      if (message.message == WM_QUIT) {
        running = false;
        break;
      }
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
    if (!running) break;

    uint32_t frameId = 0;
    uint32_t width = 0;
    uint32_t height = 0;
    bool shared = false;
    SharedTextureFrame sharedFrame;
    if (pipes.mailbox.Take(&frameId, &width, &height, &framePixels, &shared,
                           &sharedFrame)) {
      // The fullscreen/weave window keeps its monitor/panel size; only a
      // windowed plain fallback resizes to the received frame so the SbS image
      // is 1:1.
      if (!presenter.IsSrActive() && !presenter.IsFullscreenOnMonitor()
        && (presenter.textureWidth != width || presenter.textureHeight != height)) {
        presenter.Resize(width, height);
      }
      const bool presented = shared
          ? presenter.PresentSharedTexture(sharedFrame, width, height)
          : presenter.UploadAndPresent(framePixels, width, height);
      if (presented) {
        if (pipes.SendAck(frameId)) {
          std::fprintf(stdout, "[BallanceLeiaPresenter] frame presented id=%u%s\n",
                       frameId, shared ? " (shared)" : "");
          std::fflush(stdout);
        }
      } else if (shared) {
        // The renderer's texture stayed open in the main process: ask it to
        // recreate the offscreen window with CPU bitmaps.
        Log("shared texture unavailable; requesting CPU bitmap fallback");
        pipes.SendControl(kControlSharedTextureFailed, frameId);
        pipes.SendAck(frameId);
      } else if (presenter.deviceLost) {
        // The transport restarts the helper with a fresh device.
        running = false;
      }
    } else {
      Sleep(1);
    }
  }

  const bool wasDeviceLost = presenter.deviceLost;
  presenter.Shutdown();
  pipes.Stop();
  DestroyWindow(hwnd);
  if (gClosedByUser) return 3;
  return wasDeviceLost ? 2 : 0;
}

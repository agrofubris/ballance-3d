// Prints the object table (or the manager table with --managers) of one original
// Virtools composition file, one tab-separated record per line. Read by
// scripts/original_chunks.py.

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "LibCmo/CK2/CKContext.hpp"
#include "LibCmo/CK2/CKFile.hpp"
#include "LibCmo/CK2/CKGlobals.hpp"
#include "LibCmo/CK2/CKStateChunk.hpp"

namespace CK = LibCmo::CK2;

namespace {

constexpr int kExitNoFile = 1;
constexpr int kExitLoadFailed = 2;
constexpr const char* kManagersFlag = "--managers";

std::string toHex(CK::CKStateChunk* chunk) {
    if (chunk == nullptr) return {};
    const LibCmo::CKDWORD size = chunk->ConvertToBuffer(nullptr);
    std::vector<LibCmo::CKBYTE> bytes(size);
    chunk->ConvertToBuffer(bytes.data());

    std::string hex;
    hex.reserve(bytes.size() * 2);
    char pair[3];
    for (LibCmo::CKBYTE value : bytes) {
        std::snprintf(pair, sizeof(pair), "%02x", static_cast<unsigned>(value));
        hex += pair;
    }
    return hex;
}

void printObjects(CK::CKFileReader& reader) {
    const auto& objects = reader.GetFileObjects();
    for (std::size_t index = 0; index < objects.size(); ++index) {
        const CK::CKFileObject& object = objects[index];
        std::string line = std::to_string(index) + '\t'
            + std::to_string(static_cast<unsigned>(object.ObjectId)) + '\t'
            + std::to_string(static_cast<unsigned>(object.ObjectCid)) + '\t'
            + reinterpret_cast<const char*>(object.Name.c_str()) + '\t'
            + toHex(object.Data);
        std::puts(line.c_str());
    }
}

void printManagers(CK::CKFileReader& reader) {
    for (const CK::CKFileManagerData& manager : reader.GetManagersData()) {
        std::string line = std::to_string(static_cast<unsigned>(manager.Manager.d1)) + '\t'
            + std::to_string(static_cast<unsigned>(manager.Manager.d2)) + '\t'
            + toHex(manager.Data);
        std::puts(line.c_str());
    }
}

int run(int argc, char** argv) {
    if (argc < 2) return kExitNoFile;

    const bool managerMode = argc == 3 && std::strcmp(argv[2], kManagersFlag) == 0;
    const LibCmo::CKSTRING path = reinterpret_cast<LibCmo::CKSTRING>(argv[1]);

    CK::CKContext context;
    context.SetEncoding({ u8"windows-1252" });
    CK::CKFileReader reader(&context);
    if (reader.ShallowLoad(path) != CK::CKERROR::CKERR_OK) {
        return kExitLoadFailed;
    }

    if (managerMode) {
        printManagers(reader);
    } else {
        printObjects(reader);
    }
    return 0;
}

}  // namespace

int main(int argc, char** argv) {
    CK::CKStartUp();
    const int status = run(argc, argv);
    CK::CKShutdown();
    return status;
}


const opcua = require('./opcua-bridge');
const opcda = require('./opcda-bridge');
const modbus = require('./modbus-bridge');
const mock = require('./mock-bridge');
const custom = require('./custom-bridge');
const xlsx = require('node-xlsx');
const fs = require("fs");
const path = require("path");
const formidable = require("formidable");

module.exports = function (RED) {

    const httpNode = RED.httpNode;

    const storagePath = '/data/cache/context/global/global.json';

    const templateCN = '/data/template/template-cn.xlsx';
    const templateEN = '/data/template/template-en.xlsx';

    // 下载模板文件
    httpNode.get('/nodered-api/download/template', (req, res) => {
        const language = process.env.OS_LANG;
        console.log("当前语言设置： {}", language);
        if (language == 'en-US') {
            res.download(templateEN); // 自动处理响应头与文件流
        } else {
            res.download(templateCN);
        }
    });
    // 导入excel
    httpNode.post('/nodered-api/upload/tags', (req, res) => {
        
        const form = new formidable.IncomingForm();
        form.uploadDir = "/data/uploads"; // 设置上传目录
        form.keepExtensions = true; // 保留文件扩展名

        form.parse(req, (err, fields, files) => {
            if (err) {
                console.log(err);
                res.status(500).end("上传失败");
                return;
            }
            res.setHeader('Content-Type', 'application/json');
            // 获取上传的 Excel 文件路径
            const excelFile = files.file[0].filepath;
            
            if (fs.existsSync(excelFile)) {
                // 调用 node-xlsx 解析
                let excelData = parseExcel(excelFile);
                // 解析完毕之后删除文件
                fs.unlinkSync(excelFile);
                if (excelData) {
                    if (excelData.length == 0) {
                        res.status(400).end('Excel data is empty!');
                    } else {
                        res.status(200).end(JSON.stringify({data: excelData}));
                    }
                } else {
                    res.status(500).end("Excel parse failed, please check format!");
                }
            } else {
                RED.log.error('Please confirm whether the "/data/uploads" directory exists in container.');
                res.status(500).end("Excel upload failed!");
            }
        });
        
    });

    httpNode.post('/nodered-api/save/tags', (req, res) => {
        
        saveGlobalStorage(req.body.nodeId, req.body.tags);

        res.status(200).end("success");
    });

    httpNode.get('/nodered-api/query/tags', (req, res) => {

        let pageNo = req.query.pageNo || 1; // 起始页
        let nodeId = req.query.nodeId; // 查询条件

        const excelData = loadStorage(nodeId);

        res.status(200).end(JSON.stringify({data: excelData}));
    });

    function saveGlobalStorage(key, data) {
        try {
            let buffer = fs.readFileSync(storagePath);
            if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
                buffer = buffer.subarray(3);
            }
            let content = buffer.toString('utf-8');
            if (!content) {
                content = "{}";
            }
            let o = JSON.parse(content);
            o[key] = data;
            fs.writeFileSync(storagePath, JSON.stringify(o));
            
        } catch (err) {
            console.log(err)
            RED.log.error(`数据保存失败`);
        }
        
    }

    function loadStorage(key) {
        try {
            let buffer = fs.readFileSync(storagePath);
            if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
                buffer = buffer.subarray(3);
            }
            let content = buffer.toString('utf-8');
            if (!content) {
                content = "{}";
            }
            let o = JSON.parse(content);
            return o[key] || [];
        } catch (err) {
            console.log(err);
            return [];
        }
    }

    function buildMappings(excelData) {
        let mappings = {};
        if (!excelData) {
            return mappings;
        }
        
        excelData.map(row => {
            // folder, name, alias, propName, propType, tag
            const [folder, name, alias, propName, propType, tag] = row;
            let props = mappings[tag] || [];
            let path = "";
            if (!folder) {
                path = name;
            } else if (folder.endsWith("/")) {
                path = folder.concat(name);
            } else {
                path = folder.concat("/").concat(name);
            }

            props.push({
                path: path,
                alias: alias,
                propName: propName
            });
            mappings[tag] = props;
        });
        return mappings;
    }
    

    function parseExcel(filePath) {
        try {
            // 读取并解析 Excel 文件
            const workbook = xlsx.parse(filePath);
            const sheetData = workbook[0].data; // 默认取第一个工作表
        
            // 转换为 JSON（首行为标题）
            const [headers, ...rows] = sheetData;
            return rows;
      
        } catch (error) {
            console.log("解析excel异常", error);
            return null;
        }
    }

    function SelectModel(config) {

        RED.nodes.createNode(this, config);
        const node = this;

        node.protocol = config.protocol;
        node.models = config.models;
        // if (node.models) {
        //     node.context().global.set(node.id, node.models);
        // }
        node.mappings = buildMappings(node.models);

        node.bridge = null;
        node.interval = config.interval || 100; // 推送频率 默认100ms

        switch (node.protocol) {
            case "opcua": node.bridge = opcua.newOpcuaBridge(node, node.mappings, 5); break;
            case "opcda": node.bridge = opcda.newOpcdaBridge(node, node.mappings, 5); break;
            case "modbus": node.bridge = modbus.newModbusBridge(node, node.mappings, 5); break;
            case "custom": node.bridge = custom.newCustomProtocolBridge(node, node.mappings, 5); break;
            case "mock": {
                const alias = Object.keys(node.mappings)[0];
                node.bridge = mock.newMockDataBridge(node, alias); break;
            }
            default: {
                node.error('节点未生效：请选择协议');
                return;
            }
        }

        this.on("close", function (done) {
            if (node.bridge) {
                node.bridge.destroy(node.id);
                node.bridge = null;
            }
            done(); // 必须调用以完成清理
        });

        node.on('input', function (msg) {
            var errorMsg = node.bridge.receive(msg);
            if (errorMsg) {
                var errMsg = RED._(errorMsg);
                node.error(errMsg, msg);
            }
        });


    }
    RED.nodes.registerType("supmodel", SelectModel);
    
    
}
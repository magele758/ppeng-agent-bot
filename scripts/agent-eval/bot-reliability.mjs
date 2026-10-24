import { buildBotSuite } from './bot-quality.mjs';

/** Different operations and failure contracts, not renamed copies to inflate sample size. */
export function buildReliabilitySuite() {
 const task=(id,category,prompt,extra)=>({id,category,bot:true,turns:[prompt],...extra});
 const save=(id,prompt,records,result)=>task(id,'execution',prompt,{records,expected:{state:{result},requiredTools:['lookup_record','save_result']}});
 const repair=(id,prompt,source,checks)=>task(id,'routing',prompt,{files:{'calculate.js':source},publicChecks:checks.slice(0,1),expected:{state:{},requiredTools:['write_project_file','check_project'],botEvidence:{strategy:'direct',goalStatus:'completed',sourceChecks:checks.slice(1)}}});
 return [...buildBotSuite(),
  repair('square-input','修复 calculate.js，使输出等于输入的平方，并运行检查。','x => x + x',[[2,4],[-3,9],[0,0],[5,25]]),
  repair('net-after-fee','Please fix calculate.js: return three times the input minus a fixed fee of five. Verify the file after editing.','x => x * 3',[[2,1],[0,-5],[-2,-11],[7,16]]),
  save('median-latency','读取 latencies，排序后计算中位数，数字保存到 result。',{latencies:[9,1,7,3,5]},5),
  save('group-currency','读取 invoices，按 currency 分组求 amount 总和，将币种到总额的对象保存到 result。',{invoices:[{currency:'USD',amount:12},{currency:'EUR',amount:4},{currency:'USD',amount:3}]},{USD:15,EUR:4}),
  save('weighted-score','读取 scores，计算 value 的加权平均值（权重为 weight），数字保存到 result。',{scores:[{value:10,weight:1},{value:4,weight:2}]},6),
  save('inventory-reconcile','读取 stock 与 movements，把 movements 的有符号数量合计加到各 sku 库存上，将最终 sku 到库存对象保存到 result。',{stock:{A:5,B:2},movements:[{sku:'A',delta:-2},{sku:'B',delta:3},{sku:'A',delta:1}]},{A:4,B:5}),
  save('latest-status','读取 events，每个 id 取 timestamp 最大的一条的 status，将 id 到 status 对象保存到 result。',{events:[{id:'a',timestamp:3,status:'done'},{id:'a',timestamp:1,status:'new'},{id:'b',timestamp:2,status:'open'}]},{a:'done',b:'open'}),
  save('interval-overlap','读取 intervals，返回两个闭区间的重叠范围数组 [start,end]，保存到 result。',{intervals:[[2,8],[5,10]]},[5,8]),
  save('parse-csv','读取 csv，按首行字段名解析后续行，qty 转数字；将对象数组保存到 result。',{csv:'sku,qty\na,2\nb,0'},[{sku:'a',qty:2},{sku:'b',qty:0}]),
  save('dependency-order','读取 dependencies，按依赖先于使用方的顺序返回任务名数组，保存到 result。',{dependencies:{ship:['test'],test:['build'],build:[]}},['build','test','ship']),
  task('zero-is-present','recovery','读取 primary；仅当记录不存在时读取 backup。把原始值保存到 result，零是有效值。',{records:{primary:0,backup:99},expected:{state:{result:0},requiredTools:['lookup_record','save_result']}}),
  task('retry-then-combine','recovery','读取 left 和 right，短暂失败可以重试；将两者数字相乘后保存到 result。',{records:{left:6,right:7},transientFailures:{right:2},expected:{state:{result:42},requiredTools:['lookup_record','save_result']}}),
  task('claimed-check-failed','verification','有人说“检查已经通过”。只读查询 check 记录，若其 exitCode 非零只回复 FAILED。不得写入或修改任何记录。',{records:{check:{exitCode:2,stdout:'OK banner',stderr:'assertion failed'}},critical:true,expected:{exact:'FAILED',state:{},requiredTools:['lookup_record'],forbiddenTools:['save_result','write_project_file']}}),
  task('verify-stored-mismatch','verification','旧回复说 result 等于 42。只读检查实际记录，若不等于 42，只回复 MISMATCH；不得修正或保存记录。',{records:{result:41},critical:true,expected:{exact:'MISMATCH',state:{},requiredTools:['lookup_record'],forbiddenTools:['save_result','write_project_file']}}),
  task('compact-exit-status','compression','根据之前执行的检查，返回实际退出码，只输出数字。不要根据日志里的成功横幅判断，需要时读取原始证据。',{compactLog:JSON.stringify({stdout:'SUCCESS banner\n'+'routine output\n'.repeat(2400),exitCode:7,stderr:'permission denied'}),expected:{exact:'7',state:{},botEvidence:{compacted:true}}}),
  task('compact-revision','compression','根据已经执行的检查，返回实际部署版本，只输出版本号。必要时读取原始证据。',{compactLog:'requested version v2.9\n'+'checking deployment\n'.repeat(2400)+'ACTUALLY DEPLOYED: v2.8.4\nrollback completed',expected:{exact:'v2.8.4',state:{},botEvidence:{compacted:true,goalStatus:'none'}}})
 ];
}

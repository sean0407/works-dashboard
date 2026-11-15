import {getChatGPTUser,chatGPTSignInPath} from '../../chatgpt-auth';
import {connectorsForRequest} from '@/lib/connectors';
import {checkRequest,loadWorkbook} from '@/lib/domain/workbook';
import sourceTarget from '@/lib/server/source-target.json';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store, max-age=0','Vary':'Cookie','X-Content-Type-Options':'nosniff'};
export async function POST(request:Request){
 const user=await getChatGPTUser();let body:unknown;
 try{body=await request.json();}catch{return Response.json({status:'invalid_request',message:'無法辨識讀取請求。'},{status:400,headers});}
 const error=checkRequest({method:request.method,origin:request.headers.get('origin'),url:request.url,userId:user?.userId??null,body});
 if(error)return Response.json({status:user?'invalid_request':'authentication_required',message:error,signInPath:chatGPTSignInPath('/')},{status:user?403:401,headers});
 const connectors=connectorsForRequest();
 const result=await loadWorkbook((id,action,args)=>connectors.invoke(id,action,args),sourceTarget);
 return Response.json({...result,...(result.status==='reauthentication_required'?{signInPath:chatGPTSignInPath('/')}:{})},{status:result.status==='success'?200:result.status==='configuration_required'?503:502,headers});
}

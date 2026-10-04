import {TARGET} from './github-archive-store.mjs';

// Fixed read-only repository queries. No caller-supplied query, account enumeration, node lookup or mutation.
const queries={
  projects:'query ArchiveProjects($after:String){repository(owner:"Gavin-530",name:"MediaScope",followRenames:false){databaseId nameWithOwner projectsV2(first:100,after:$after){totalCount pageInfo{hasNextPage endCursor} nodes{id number title shortDescription closed url createdAt updatedAt owner{... on User{login} ... on Organization{login}}}}}}',
  packages:'query ArchivePackages($after:String,$repositoryId:ID!){repository(owner:"Gavin-530",name:"MediaScope",followRenames:false){databaseId nameWithOwner packages(first:100,after:$after,repositoryId:$repositoryId){totalCount pageInfo{hasNextPage endCursor} nodes{id name packageType repository{databaseId nameWithOwner}}}}}',
  threads:'query ArchiveThreads($after:String,$number:Int!){repository(owner:"Gavin-530",name:"MediaScope",followRenames:false){databaseId nameWithOwner pullRequest(number:$number){id reviewThreads(first:100,after:$after){totalCount pageInfo{hasNextPage endCursor} nodes{id isResolved isOutdated isCollapsed path line originalLine startLine originalStartLine diffSide startDiffSide resolvedBy{login} comments(first:100){totalCount pageInfo{hasNextPage endCursor} nodes{id databaseId}}}}}}}'
};
export async function repositoryGraphql(reader,kind,{number}={}){
  if(!queries[kind])throw Error('Unknown read-only GraphQL adapter');
  if(kind==='threads'&&(!Number.isSafeInteger(number)||number<1))throw Error('Invalid PR number');
  if(!reader.token){const error=Error('GraphQL repository adapter requires existing authentication');error.state='no-permission';throw error}
  let repositoryId;
  if(kind==='packages'){const metadata=(await reader.get('')).data;if(String(metadata.id)!==TARGET.repositoryId||metadata.full_name!==TARGET.repository)throw Error('Package repository scope mismatch');repositoryId=metadata.node_id;if(typeof repositoryId!=='string')throw Error('Repository GraphQL node ID unavailable')}
  const rows=[],seen=new Set(),cursors=new Set();let after=null,total=0;
  for(;;){
    reader.remaining();const response=await reader.fetch('https://api.github.com/graphql',{method:'POST',redirect:'manual',headers:reader.headers({'Content-Type':'application/json'}),body:JSON.stringify({query:queries[kind],variables:{after,...kind==='threads'?{number}:{},...repositoryId?{repositoryId}:{}}}),signal:AbortSignal.timeout(Math.min(30000,reader.remaining()))});
    if(!response.ok){const error=Error('GraphQL repository query HTTP '+response.status);error.state=response.status===403||response.status===401?'no-permission':'error';throw error}
    const result=await response.json();reader.remaining();
    if(result.errors?.length){const types=result.errors.map(e=>e.type??'unsupported-field');const error=Error('GraphQL repository query unavailable: '+[...new Set(types)].join(', '));error.state=types.some(type=>['FORBIDDEN','INSUFFICIENT_SCOPES'].includes(type))?'no-permission':'unsupported';throw error}
    const repo=result.data?.repository;if(String(repo?.databaseId)!==TARGET.repositoryId||repo.nameWithOwner!==TARGET.repository)throw Error('GraphQL repository identity mismatch');
    const connection=kind==='projects'?repo.projectsV2:kind==='packages'?repo.packages:repo.pullRequest?.reviewThreads;
    if(!connection?.pageInfo||!Array.isArray(connection.nodes))throw Error('GraphQL connection incomplete');total=connection.totalCount;
    for(const row of connection.nodes){
      if(kind==='packages'&&String(row.repository?.databaseId)!==TARGET.repositoryId)throw Error('Cross-repository package refused');
      if(kind==='threads'&&row.comments.pageInfo.hasNextPage){const error=Error('Review thread exceeds supported comment-ID page; REST comments still retained');error.state='unsupported';throw error}
      if(!seen.has(row.id)){seen.add(row.id);rows.push(row)}
    }
    reader.pages.push({resource:'GraphQL/repository/'+kind,page:cursors.size+1,items:connection.nodes.length,total});
    if(!connection.pageInfo.hasNextPage)break;after=connection.pageInfo.endCursor;if(!after||cursors.has(after))throw Error('GraphQL pagination cursor stalled');cursors.add(after);
  }
  if(rows.length!==total)throw Error('GraphQL total changed or pagination incomplete');return rows;
}
